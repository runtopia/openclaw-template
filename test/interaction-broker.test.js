import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  InteractionBrokerService,
  createInteractionBrokerRuntime,
} from "../src/interactions/broker.js";

test("interaction broker refuses a non-loopback listener", async () => {
  await assert.rejects(
    createInteractionBrokerRuntime({ host: "0.0.0.0" }),
    /must be loopback/,
  );
});

test("interaction broker resolves a pending plugin request with structured answers", async (t) => {
  const runtime = await createInteractionBrokerRuntime({ maxWaitMs: 1_000 });
  t.after(() => runtime.stop());

  const pending = fetch(`${runtime.gatewayEnv.ONECLAW_INTERACTION_BROKER_URL}/v1/input`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.gatewayEnv.ONECLAW_INTERACTION_BROKER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ toolCallId: "call-1" }),
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (runtime.service.getByToolCallId("call-1")) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(runtime.service.getByToolCallId("call-1"));

  assert.deepEqual(runtime.service.submit({
    runId: "run-1",
    toolCallId: "call-1",
    answers: [{ questionId: "audience", selected: ["Executives"] }],
  }), { success: true, status: "submitted" });

  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    answers: [{ questionId: "audience", selected: ["Executives"] }],
  });
});

test("interaction broker rejects requests without its process-private token", async (t) => {
  const runtime = await createInteractionBrokerRuntime({ maxWaitMs: 1_000 });
  t.after(() => runtime.stop());

  const response = await fetch(
    `${runtime.gatewayEnv.ONECLAW_INTERACTION_BROKER_URL}/v1/input`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toolCallId: "call-unauthorized" }),
    },
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false, error: "UNAUTHORIZED" });
});

test("interaction broker waits briefly for the plugin to register", async () => {
  const service = new InteractionBrokerService({
    maxWaitMs: 1_000,
    registrationGraceMs: 100,
    terminalTtlMs: 1_000,
  });
  const submission = service.submitWhenReady({
    runId: "run-fast",
    toolCallId: "call-fast",
    answers: [{ questionId: "format", selected: [], custom: "Short memo" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const pending = service.waitForInput("call-fast");

  assert.deepEqual(await submission, { success: true, status: "submitted" });
  assert.deepEqual(await pending, [
    { questionId: "format", selected: [], custom: "Short memo" },
  ]);
  service.close();
});

test("interaction broker makes exact retries idempotent and rejects changed answers", async () => {
  const service = new InteractionBrokerService({ terminalTtlMs: 1_000 });
  const answers = [{ questionId: "format", selected: ["Memo"] }];
  const pending = service.waitForInput("call-idempotent");

  assert.deepEqual(service.submit({
    runId: "run-1",
    toolCallId: "call-idempotent",
    answers,
  }), { success: true, status: "submitted" });
  assert.deepEqual(await pending, answers);
  assert.deepEqual(service.submit({
    runId: "run-1",
    toolCallId: "call-idempotent",
    answers,
  }), { success: true, status: "already_submitted" });
  assert.deepEqual(service.submit({
    runId: "run-1",
    toolCallId: "call-idempotent",
    answers: [{ questionId: "format", selected: ["Slides"] }],
  }), { success: false, code: "INTERACTION_ALREADY_ANSWERED" });
  assert.deepEqual(service.submit({
    runId: "run-2",
    toolCallId: "call-idempotent",
    answers,
  }), { success: false, code: "INTERACTION_ALREADY_ANSWERED" });
  service.close();
});

test("interaction broker distinguishes unknown and expired interactions", async () => {
  const service = new InteractionBrokerService({
    maxWaitMs: 10,
    registrationGraceMs: 5,
    terminalTtlMs: 1_000,
  });
  const answers = [{ questionId: "format", selected: ["Memo"] }];

  assert.deepEqual(await service.submitWhenReady({
    runId: "run-1",
    toolCallId: "call-missing",
    answers,
  }), { success: false, code: "INTERACTION_NOT_FOUND" });

  const pending = service.waitForInput("call-expired");
  await assert.rejects(pending, /INPUT_REQUEST_TIMED_OUT/);
  assert.deepEqual(service.submit({
    runId: "run-1",
    toolCallId: "call-expired",
    answers,
  }), { success: false, code: "INTERACTION_EXPIRED" });
  service.close();
});

test("interaction broker expires a cancelled plugin wait", async () => {
  const service = new InteractionBrokerService({ terminalTtlMs: 1_000 });
  const pending = service.waitForInput("call-cancelled");

  assert.equal(service.expire("call-cancelled"), true);
  await assert.rejects(pending, /INPUT_REQUEST_CANCELLED/);
  assert.deepEqual(service.submit({
    runId: "run-1",
    toolCallId: "call-cancelled",
    answers: [{ questionId: "format", selected: ["Memo"] }],
  }), { success: false, code: "INTERACTION_EXPIRED" });
  service.close();
});

test("interaction broker times out an unanswered plugin request", async (t) => {
  const runtime = await createInteractionBrokerRuntime({ maxWaitMs: 20 });
  t.after(() => runtime.stop());

  const response = await fetch(`${runtime.gatewayEnv.ONECLAW_INTERACTION_BROKER_URL}/v1/input`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${runtime.gatewayEnv.ONECLAW_INTERACTION_BROKER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ toolCallId: "call-timeout" }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "INPUT_REQUEST_TIMED_OUT",
  });
});

test("interaction broker recovers pending and terminal attention state across restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-attention-"));
  const statePath = path.join(directory, "broker.sqlite");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const now = Date.now();
  const attention = {
    attentionId: "attention_restart",
    toolCallId: "call_restart",
    runId: "run_restart",
    revision: 1,
    title: "Choose a format",
    questions: [{
      id: "format",
      header: "Format",
      question: "Which output format should be used?",
      options: [{ id: "memo", label: "Memo" }],
      allowCustom: true,
      multiple: false,
    }],
    createdAt: now,
    expiresAt: now + 60_000,
  };

  const first = new InteractionBrokerService({ statePath });
  assert.equal(first.createAttention(attention).created, true);
  assert.deepEqual(
    first.listPendingEvents().map((entry) => entry.event.type),
    ["attention.created"],
  );
  first.close();

  const second = new InteractionBrokerService({ statePath });
  assert.equal(second.listPending()[0].attentionId, "attention_restart");
  assert.equal(second.createAttention(attention).duplicate, true);
  const answers = [{ questionId: "format", selectedOptionIds: ["memo"] }];
  const submitted = second.submit({
    attentionId: "attention_restart",
    runId: "run_restart",
    expectedRevision: 1,
    answers,
  }, { detailed: true });
  assert.equal(submitted.success, true);
  assert.equal(submitted.attention.revision, 2);
  second.close();

  const third = new InteractionBrokerService({ statePath });
  assert.deepEqual(third.submit({
    attentionId: "attention_restart",
    runId: "run_restart",
    expectedRevision: 1,
    answers,
  }, { detailed: true }).status, "already_submitted");
  assert.equal(third.submit({
    attentionId: "attention_restart",
    runId: "run_restart",
    expectedRevision: 2,
    answers: [{ questionId: "format", text: "Slides" }],
  }, { detailed: true }).protocolCode, "revision_conflict");
  assert.deepEqual(
    third.listPendingEvents().map((entry) => entry.event.type),
    ["attention.created", "attention.resolved"],
  );
  assert.equal(
    third.markEventPublished("attention_restart:1:attention.created"),
    true,
  );
  assert.deepEqual(
    third.listPendingEvents().map((entry) => entry.event.type),
    ["attention.resolved"],
  );
  third.close();
});

test("interaction broker persists expiration and its terminal event", () => {
  let now = 1_000;
  const service = new InteractionBrokerService({
    maxWaitMs: 1_000,
    now: () => now,
    terminalTtlMs: 10_000,
  });
  service.createAttention({
    attentionId: "attention_expiry",
    toolCallId: "call_expiry",
    runId: "run_expiry",
    revision: 1,
    title: "Approval",
    questions: [{
      id: "approve",
      header: "Approval",
      question: "Proceed?",
      options: [{ id: "yes", label: "Yes" }],
      allowCustom: false,
      multiple: false,
    }],
    createdAt: now,
    expiresAt: 1_500,
  });
  now = 2_000;
  service.sweepExpired();

  assert.equal(service.listPending().length, 0);
  assert.deepEqual(
    service.listPendingEvents().map((entry) => [
      entry.event.type,
      entry.event.revision,
      entry.event.payload.status,
    ]),
    [
      ["attention.created", 1, "pending"],
      ["attention.expired", 2, "expired"],
    ],
  );
  service.close();
});
