import test from "node:test";
import assert from "node:assert/strict";
import {
  createTaskBroker,
  validateTaskInput,
} from "../src/browser/task-broker.js";
test("broker uses authority target rather than a caller-supplied target", async () => {
  const calls = [];
  const broker = createTaskBroker({
    rpc: {
      rpcGateway: async (method, fields) => {
        calls.push(fields);
        return { ok: true, payload: { targetId: "owned-tab" } };
      },
    },
    dispatch: async (target, input) => {
      assert.equal(target, "owned-tab");
      assert.equal(input.type, "text");
    },
  });
  await broker({
    action: "input",
    sessionKey: "a",
    browserTaskId: "task-a",
    targetId: "other-tab",
    token: "t",
    event: { type: "text", text: "中文" },
  });
  assert.deepEqual(
    calls.map((c) => c.action),
    ["input-begin", "input-end"],
  );
  assert.equal(calls[1].uncertain, false);
  assert.equal(calls[0].callId, calls[1].callId);
});
test("uncertain transport ends paused and never clears execution as successful", async () => {
  const calls = [];
  const broker = createTaskBroker({
    rpc: {
      rpcGateway: async (_, fields) => {
        calls.push(fields);
        return { ok: true, payload: { targetId: "t" } };
      },
    },
    dispatch: async () => {
      throw Object.assign(new Error(), { browserOperationUncertain: true });
    },
  });
  await assert.rejects(
    broker({
      action: "input",
      sessionKey: "a",
      browserTaskId: "task-a",
      token: "t",
      event: { type: "key", key: "Enter" },
    }),
    /paused/,
  );
  assert.equal(calls.at(-1).uncertain, true);
});
test("invalid input and denied authority never open a page transport", async () => {
  let dispatches = 0;
  const broker = createTaskBroker({
    rpc: { rpcGateway: async () => ({ ok: false }) },
    dispatch: async () => {
      dispatches++;
    },
  });
  for (const event of [
    { type: "text", text: "x" },
    { type: "evaluate", expression: "secret" },
    { type: "down", x: NaN, y: 0 },
    { type: "key", key: "Unknown" },
  ])
    await assert.rejects(
      broker({ action: "input", sessionKey: "a", browserTaskId: "a", event }),
    );
  assert.equal(dispatches, 0);
  assert.throws(() =>
    validateTaskInput({ type: "scroll", x: 0, y: 0, deltaY: 99999 }),
  );
});
