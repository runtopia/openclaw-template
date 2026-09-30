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
test("lost completion acknowledgement is reconciled before status without replaying native input", async () => {
  const calls = [];
  let fail = true, dispatches = 0;
  const broker = createTaskBroker({ rpc: { rpcGateway: async (_, fields) => {
    calls.push(fields);
    if (fields.action === "input-end" && fail) { fail = false; throw new Error("connection lost"); }
    return { ok: true, payload: { targetId: "owned" } };
  } }, dispatch: async () => { dispatches++; } });
  const identity = { sessionKey: "a", browserTaskId: "a", token: "token" };
  await assert.rejects(broker({ ...identity, action: "input", event: { type: "text", text: "once" } }));
  await broker({ ...identity, action: "status" });
  assert.equal(dispatches, 1);
  assert.deepEqual(calls.map(c => c.action), ["input-begin", "input-end", "input-end", "status"]);
  assert.deepEqual(calls[1], calls[2]);
});
test("lost admission acknowledgement is drained without ever dispatching input", async () => {
  const calls = [];
  let dispatches = 0;
  const broker = createTaskBroker({ rpc: { rpcGateway: async (_, fields) => {
    calls.push(fields);
    if (fields.action === "input-begin") throw new Error("admission acknowledgement lost");
    return { ok: true, payload: {} };
  } }, dispatch: async () => { dispatches++; } });
  await assert.rejects(broker({ sessionKey: "a", browserTaskId: "a", token: "token", action: "input", event: { type: "key", key: "Enter" } }));
  assert.equal(dispatches, 0);
  assert.deepEqual(calls.map(c => c.action), ["input-begin", "input-end"]);
  assert.equal(calls[1].uncertain, false);
});
test("rejected admission does not leave a fictitious completion blocking later status", async () => {
  const calls = [];
  const broker = createTaskBroker({ rpc: { rpcGateway: async (_, fields) => {
    calls.push(fields.action);
    return fields.action === "input-begin" ? { ok: false, error: { message: "Task frame changed; refresh before input" } }
      : { ok: true, payload: { mode: "paused" } };
  } } });
  const identity = { sessionKey: "a", browserTaskId: "a", token: "token" };
  await assert.rejects(broker({ ...identity, action: "input", event: { type: "text", text: "stale" } }));
  assert.equal((await broker({ ...identity, action: "status" })).mode, "paused");
  assert.deepEqual(calls, ["input-begin", "status"]);
});
