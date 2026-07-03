import { test } from "node:test";
import assert from "node:assert/strict";
import { getActiveChannels } from "../src/channels/manifest.js";

// 回归:已配置实例上启用微信走的是 reconcileAllChannels(只看 CHANNEL_MANIFEST)。
// 微信若不在 manifest 里,WECHAT_ENABLED=1 在重新部署后不会激活通道。
test("WECHAT_ENABLED=1 激活 openclaw-weixin 通道", () => {
  const active = getActiveChannels({ WECHAT_ENABLED: "1" });
  const wechat = active.find((c) => c.id === "openclaw-weixin");
  assert.ok(wechat, "openclaw-weixin 应出现在 active channels 里");
  assert.equal(wechat.kind, "qr");
  assert.equal(wechat.pluginId, "openclaw-weixin");
  const shape = wechat.reconcileShape({ WECHAT_ENABLED: "1" });
  assert.equal(shape.enabled, true);
  assert.equal(shape.dmPolicy, "pairing");
  assert.deepEqual(shape.allowFrom, []);
  assert.equal(shape.groupPolicy, "disabled");
});

test("WEIXIN_ENABLED 别名同样激活 openclaw-weixin", () => {
  const active = getActiveChannels({ WEIXIN_ENABLED: "true" });
  assert.ok(active.some((c) => c.id === "openclaw-weixin"));
});

test("未设微信环境变量时不激活", () => {
  const active = getActiveChannels({});
  assert.equal(active.some((c) => c.id === "openclaw-weixin"), false);
});

test("whatsapp 仍可用(回归)", () => {
  const active = getActiveChannels({ WHATSAPP_ENABLED: "1" });
  const whatsapp = active.find((c) => c.id === "whatsapp");
  assert.ok(whatsapp);
  const shape = whatsapp.reconcileShape({ WHATSAPP_ENABLED: "1" });
  assert.equal(shape.enabled, true);
  assert.equal(shape.dmPolicy, "pairing");
  assert.deepEqual(shape.allowFrom, []);
  assert.equal(shape.groupPolicy, "disabled");
});
