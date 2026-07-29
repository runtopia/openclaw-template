import assert from "node:assert/strict";
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
  await new Promise((resolve) => setTimeout(resolve, 20));

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
