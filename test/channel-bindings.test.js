import test from "node:test";
import assert from "node:assert/strict";
import { readChannelBindings, applyChannelBinding, applyChannelAccountBinding, removeChannelBinding } from "../src/channels/bindings.js";

test("readChannelBindings returns enabled channels, accounts, and bindings", () => {
  const cfg = {
    channels: {
      whatsapp: { enabled: true, accounts: { emp1: { enabled: true } } },
      "openclaw-weixin": { enabled: true, accounts: { wxid1: { enabled: true } } },
      telegram: { enabled: true, accounts: { emp2: { botToken: "secret" } } },
    },
    bindings: [
      { agentId: "agent-a", match: { channel: "whatsapp", accountId: "emp1" } },
      { agentId: "agent-b", match: { channel: "openclaw-weixin", accountId: "wxid1" } },
    ],
  };

  assert.deepEqual(readChannelBindings(cfg), {
    ok: true,
    bindings: [
      { channel: "whatsapp", accountId: "emp1", agentId: "agent-a" },
      { channel: "openclaw-weixin", accountId: "wxid1", agentId: "agent-b" },
    ],
    channels: {
      whatsapp: { enabled: true, accounts: ["emp1"] },
      "openclaw-weixin": { enabled: true, accounts: ["wxid1"] },
      telegram: { enabled: true, accounts: ["emp2"] },
    },
  });
});

test("applyChannelBinding replaces the same channel and account id", () => {
  const cfg = {
    channels: { whatsapp: { enabled: true, accounts: { emp1: { enabled: true } } } },
    bindings: [
      { agentId: "old-agent", match: { channel: "whatsapp", accountId: "emp1" } },
      { agentId: "other-agent", match: { channel: "whatsapp", accountId: "emp2" } },
    ],
  };

  const binding = applyChannelBinding(cfg, {
    channel: "whatsapp",
    accountId: "emp1",
    agentId: "new-agent",
  });

  assert.deepEqual(binding, { channel: "whatsapp", accountId: "emp1", agentId: "new-agent" });
  assert.deepEqual(cfg.bindings, [
    { agentId: "other-agent", match: { channel: "whatsapp", accountId: "emp2" } },
    { agentId: "new-agent", match: { channel: "whatsapp", accountId: "emp1" } },
  ]);
  assert.deepEqual(cfg.channels.whatsapp.accounts.emp1, { enabled: true });
});

test("removeChannelBinding removes account and matching binding", () => {
  const cfg = {
    channels: { telegram: { enabled: true, accounts: { emp1: { botToken: "secret" }, emp2: { botToken: "x" } } } },
    bindings: [
      { agentId: "agent-a", match: { channel: "telegram", accountId: "emp1" } },
      { agentId: "agent-b", match: { channel: "telegram", accountId: "emp2" } },
    ],
  };

  const result = removeChannelBinding(cfg, { channel: "telegram", accountId: "emp1", agentId: "agent-a" });

  assert.deepEqual(result, { removed: true, channel: "telegram", accountId: "emp1", agentId: "agent-a" });
  assert.deepEqual(Object.keys(cfg.channels.telegram.accounts), ["emp2"]);
  assert.deepEqual(cfg.bindings, [
    { agentId: "agent-b", match: { channel: "telegram", accountId: "emp2" } },
  ]);
});

test("removeChannelBinding requires accountId and agentId", () => {
  const cfg = {
    channels: { telegram: { enabled: true, accounts: { emp1: { botToken: "secret" } } } },
    bindings: [
      { agentId: "agent-a", match: { channel: "telegram", accountId: "emp1" } },
    ],
  };

  assert.throws(
    () => removeChannelBinding(cfg, { channel: "telegram", agentId: "agent-a" }),
    /accountId required/
  );
  assert.throws(
    () => removeChannelBinding(cfg, { channel: "telegram", accountId: "emp1" }),
    /agentId required/
  );
  assert.deepEqual(Object.keys(cfg.channels.telegram.accounts), ["emp1"]);
  assert.deepEqual(cfg.bindings, [
    { agentId: "agent-a", match: { channel: "telegram", accountId: "emp1" } },
  ]);
});

test("removeChannelBinding leaves config unchanged for wrong agent", () => {
  const cfg = {
    channels: { telegram: { enabled: true, accounts: { emp1: { botToken: "secret" } } } },
    bindings: [
      { agentId: "agent-a", match: { channel: "telegram", accountId: "emp1" } },
    ],
  };

  const result = removeChannelBinding(cfg, { channel: "telegram", accountId: "emp1", agentId: "agent-b" });

  assert.deepEqual(result, { removed: false, channel: "telegram", accountId: "emp1", agentId: "agent-b" });
  assert.deepEqual(Object.keys(cfg.channels.telegram.accounts), ["emp1"]);
  assert.deepEqual(cfg.bindings, [
    { agentId: "agent-a", match: { channel: "telegram", accountId: "emp1" } },
  ]);
});

test("token channel accounts bind independently and final unbind cleans channel plugin", () => {
  const cfg = { channels: {}, bindings: [], plugins: { entries: { slack: { enabled: true } } } };
  applyChannelAccountBinding(cfg, { channel: "slack", accountId: "agent-a", agentId: "agent-a", account: { botToken: "a", appToken: "aa" } });
  applyChannelAccountBinding(cfg, { channel: "slack", accountId: "agent-b", agentId: "agent-b", account: { botToken: "b", appToken: "bb" } });

  removeChannelBinding(cfg, { channel: "slack", accountId: "agent-a", agentId: "agent-a" });
  assert.equal(cfg.channels.slack.accounts["agent-b"].botToken, "b");
  assert.equal(cfg.bindings.length, 1);

  const result = removeChannelBinding(cfg, { channel: "slack", accountId: "agent-b", agentId: "agent-b" });
  assert.equal(result.channelRemoved, true);
  assert.equal(cfg.channels.slack, undefined);
  assert.equal(cfg.plugins.entries.slack.enabled, false);
  assert.deepEqual(cfg.bindings, []);
});
