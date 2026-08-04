import assert from "node:assert/strict";
import test from "node:test";

import {
  WorkflowEventReconciler,
  createChannelAttentionController,
  decodeAttentionAnswers,
  normalizeAttentionQuestions,
  taskSnapshotEvent,
} from "../resources/openclaw-plugins/oneclaw-workflows/runtime-integration.mjs";

function clone(value) {
  return structuredClone(value);
}

function flow(overrides = {}) {
  return {
    flowId: "flow_123",
    controllerId: "oneclaw/request-first",
    revision: 0,
    status: "running",
    goal: "Prepare the launch brief",
    currentStep: "Collect requirements",
    createdAt: 1_000,
    updatedAt: 1_100,
    ...overrides,
  };
}

test("workflow task snapshots use monotonic protocol revisions and full state", () => {
  const running = taskSnapshotEvent(flow(), "run_123");
  const waiting = taskSnapshotEvent(flow({
    revision: 1,
    status: "waiting",
    blockedSummary: "Choose the target audience",
    updatedAt: 1_200,
  }), "run_123");

  assert.equal(running.type, "task.snapshot");
  assert.equal(running.revision, 1);
  assert.equal(running.payload.phase, "running");
  assert.equal(waiting.revision, 2);
  assert.equal(waiting.payload.phase, "waiting_input");
  assert.equal(waiting.payload.steps[0].status, "waiting");
  assert.equal(waiting.payload.attentionSummary, "Choose the target audience");

  const succeeded = taskSnapshotEvent(flow({
    revision: 2,
    status: "succeeded",
    updatedAt: 1_300,
  }), "run_123");
  assert.equal(succeeded.payload.phase, "completed");
  assert.equal(succeeded.payload.steps[0].status, "completed");
});

test("workflow reconciliation closes the state-commit/event-publish crash gap", async () => {
  let registry = { schemaVersion: 1, sessions: {}, flows: {} };
  const published = [];
  const current = flow({ revision: 3, updatedAt: 2_000 });
  const reconciler = new WorkflowEventReconciler({
    load: async () => clone(registry),
    save: async (next) => {
      registry = clone(next);
    },
    listFlows: async () => [current],
    publish: async (event) => {
      published.push(clone(event));
      return {
        status: "accepted",
        eventId: "event_123",
        idempotencyKey: `${event.resourceId}:${event.revision}:${event.type}`,
      };
    },
  });

  await reconciler.rememberInvocation("session_123", "run_123");
  assert.equal(registry.flows.flow_123, undefined);

  assert.deepEqual(await reconciler.reconcile(), { delivered: 1, pending: 0 });
  assert.equal(published.length, 1);
  assert.equal(published[0].revision, 4);
  assert.equal(registry.flows.flow_123.status, "delivered");

  assert.deepEqual(await reconciler.reconcile(), { delivered: 1, pending: 0 });
  assert.equal(published.length, 1);
});

test("workflow reconciliation preserves the original event identity after a pending publish", async () => {
  let registry = { schemaVersion: 1, sessions: {}, flows: {} };
  const attempts = [];
  const current = flow({ revision: 2, updatedAt: 2_000 });
  let accept = false;
  const reconciler = new WorkflowEventReconciler({
    load: async () => clone(registry),
    save: async (next) => {
      registry = clone(next);
    },
    listFlows: async () => [current],
    publish: async (event) => {
      attempts.push(clone(event));
      return accept
        ? {
            status: "duplicate",
            eventId: "event_123",
            idempotencyKey: `${event.resourceId}:${event.revision}:${event.type}`,
          }
        : {
            status: "pending",
            idempotencyKey: `${event.resourceId}:${event.revision}:${event.type}`,
            reason: "sink_unavailable",
          };
    },
  });

  await reconciler.rememberInvocation("session_123", "run_original");
  assert.equal(
    (await reconciler.publishFlow(current, "session_123", "run_original")).eventDelivery,
    "pending",
  );
  await reconciler.rememberInvocation("session_123", "run_later");
  accept = true;
  await reconciler.reconcile();

  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].runId, "run_original");
  assert.equal(attempts[1].runId, "run_original");
  assert.equal(attempts[0].revision, attempts[1].revision);
});

test("attention question ids are Protocol-safe and answers decode to tool-facing labels", () => {
  const normalized = normalizeAttentionQuestions([{
    id: "受众",
    header: "Audience",
    question: "Who is this for?",
    options: [{ label: "高管" }, { label: "Engineering" }],
    allowCustom: true,
    multiple: false,
  }]);
  const question = normalized.questions[0];
  assert.match(question.id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u);
  assert.match(question.options[0].id, /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u);

  assert.deepEqual(decodeAttentionAnswers([{
    questionId: question.id,
    selectedOptionIds: [question.options[0].id],
    text: "Board",
  }], normalized.mappings), [{
    questionId: "受众",
    selected: ["高管"],
    custom: "Board",
  }]);
});

test("connection authorization uses direct OneClaw Channel attention events", async (t) => {
  const published = [];
  const controller = createChannelAttentionController({
    publisher: async (event) => {
      published.push(clone(event));
      return {
        status: "accepted",
        eventId: `event_${published.length}`,
        idempotencyKey: `${event.resourceId}:${event.revision}:${event.type}`,
      };
    },
    now: (() => {
      let value = 1_000;
      return () => value += 100;
    })(),
  });
  t.after(() => controller.close());
  const pending = controller.requestConnection({
    args: {
      serviceId: "gmail",
      serviceName: "Gmail",
      reason: "Read the requested Gmail messages.",
      authorizeLabel: "授权 Gmail",
      cancelLabel: "暂不授权",
    },
    runId: "run_gmail",
    sessionKey: "session_gmail",
    toolCallId: "call_gmail",
  });

  await new Promise((resolve) => setImmediate(resolve));
  const created = published[0];
  assert.equal(created.type, "attention.created");
  assert.equal(created.producer, "attention");
  assert.equal(created.payload.kind, "connection");
  assert.equal(created.payload.actions[0].label, "授权 Gmail");
  assert.equal(created.payload.actions[0].command.actionId, "connect:gmail");

  assert.equal(await controller.respond({
    type: "command.attention.respond",
    payload: {
      runId: "run_gmail",
      toolCallId: "call_gmail",
      attentionId: created.resourceId,
      expectedRevision: 1,
      actionId: "connect:gmail",
    },
  }), "resolved");

  assert.deepEqual(await pending, {
    attentionId: created.resourceId,
    actionId: "connect:gmail",
    eventDelivery: "delivered",
  });
  assert.deepEqual(
    published.map((event) => [event.type, event.revision, event.payload.status]),
    [
      ["attention.created", 1, "pending"],
      ["attention.resolved", 2, "resolved"],
    ],
  );
  assert.equal(await controller.respond({
    type: "command.attention.respond",
    payload: {
      runId: "run_gmail",
      toolCallId: "call_gmail",
      attentionId: created.resourceId,
      expectedRevision: 1,
      actionId: "connect:gmail",
    },
  }), "duplicate");
});

test("structured input uses direct OneClaw Channel attention events", async (t) => {
  const published = [];
  const publisher = async (event) => {
    published.push(clone(event));
    return {
      status: "accepted",
      eventId: `event_${published.length}`,
      idempotencyKey: `${event.resourceId}:${event.revision}:${event.type}`,
    };
  };
  const controller = createChannelAttentionController({ publisher });
  t.after(() => controller.close());
  const pending = controller.requestInput({
    args: {
      title: "Audience",
      questions: [{
        id: "audience",
        header: "Audience",
        question: "Who is this for?",
        options: [{ label: "Executives" }],
        allowCustom: true,
        multiple: false,
      }],
    },
    runId: "run_123",
    sessionKey: "session_123",
    toolCallId: "call_123",
  });

  await new Promise((resolve) => setImmediate(resolve));
  const attention = published[0];
  assert.equal(attention.type, "attention.created");
  assert.equal(attention.producer, "attention");
  assert.equal(attention.payload.kind, "business_input");
  const optionId = attention.payload.questions[0].options[0].id;
  const command = {
    type: "command.attention.respond",
    payload: {
      attentionId: attention.resourceId,
      toolCallId: attention.toolCallId,
      runId: "run_123",
      expectedRevision: 1,
      answers: [{
        questionId: attention.payload.questions[0].id,
        selectedOptionIds: [optionId],
      }],
    },
  };
  assert.equal(await controller.respond(command), "resolved");
  assert.deepEqual(await pending, {
    attentionId: attention.resourceId,
    answers: [{
      questionId: "audience",
      selected: ["Executives"],
    }],
    eventDelivery: "delivered",
  });
  assert.equal(await controller.respond(command), "duplicate");
  assert.deepEqual(
    published.map((event) => event.type),
    ["attention.created", "attention.resolved"],
  );
});
