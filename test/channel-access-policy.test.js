import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRuntimeChannelAccessPolicy,
  normalizeChannelAccessPolicy,
  applyChannelPolicy,
  mergeChannelPolicy,
} from "../src/lib/channel-access-policy.js";

test("default policy maps to pairing and disabled groups", () => {
  assert.deepEqual(buildRuntimeChannelAccessPolicy(undefined), {
    dmPolicy: "pairing",
    groupPolicy: "disabled",
  });
});

test("public policy maps to open with allow all", () => {
  assert.deepEqual(buildRuntimeChannelAccessPolicy({ mode: "public" }), {
    dmPolicy: "open",
    allowFrom: ["*"],
    groupPolicy: "disabled",
  });
});

test("allowlist policy normalizes sender ids", () => {
  assert.deepEqual(normalizeChannelAccessPolicy({
    mode: "allowlist",
    allowFrom: [" +8613800138000 ", "+8613800138000", "telegram-user-id"],
  }), {
    mode: "allowlist",
    allowFrom: ["+8613800138000", "telegram-user-id"],
    groupMode: "disabled",
    groupAllowFrom: [],
    requireMention: true,
  });
});

test("applyChannelPolicy writes runtime policy at channel level", () => {
  const cfg = { channels: { whatsapp: { enabled: true, accounts: { emp1: { enabled: true } } } } };

  applyChannelPolicy(cfg, {
    channel: "whatsapp",
    access: { mode: "allowlist", allowFrom: ["+8613800138000"] },
  });

  assert.equal(cfg.channels.whatsapp.dmPolicy, "allowlist");
  assert.deepEqual(cfg.channels.whatsapp.allowFrom, ["+8613800138000"]);
  assert.equal(cfg.channels.whatsapp.groupPolicy, "disabled");
  assert.deepEqual(cfg.channels.whatsapp.accounts, { emp1: { enabled: true } });
});

test("applyChannelPolicy writes runtime policy at account level", () => {
  const cfg = { channels: { telegram: { enabled: true, accounts: { emp1: { enabled: true } } } } };

  applyChannelPolicy(cfg, {
    channel: "telegram",
    accountId: "emp1",
    access: { mode: "approval" },
  });

  assert.equal(cfg.channels.telegram.accounts.emp1.dmPolicy, "pairing");
  assert.equal(cfg.channels.telegram.accounts.emp1.groupPolicy, "disabled");
});

test("mergeChannelPolicy preserves existing non-public policy during reconcile", () => {
  const existing = {
    enabled: true,
    dmPolicy: "pairing",
    accounts: { emp1: { enabled: true, dmPolicy: "allowlist", allowFrom: ["u1"] } },
  };
  const incoming = { enabled: true, dmPolicy: "open", allowFrom: ["*"] };

  assert.deepEqual(mergeChannelPolicy(existing, incoming), {
    enabled: true,
    dmPolicy: "pairing",
    accounts: { emp1: { enabled: true, dmPolicy: "allowlist", allowFrom: ["u1"] } },
  });
});
