#!/usr/bin/env node
// Run inside the isolated test Runtime. Uses native browser.request, no LLM key.
import fs from "node:fs";
import assert from "node:assert/strict";
import { createGatewayRpc } from "../src/gateway/rpc.js";
const state = process.env.OPENCLAW_STATE_DIR || "/data/.openclaw";
const rpc = createGatewayRpc({ gatewayHost: "127.0.0.1", gatewayPort: Number(process.env.INTERNAL_GATEWAY_PORT || 18789), gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || fs.readFileSync(`${state}/gateway.token`, "utf8").trim() });
const request = async (method, path, body, query = {}) => {
  const frame = await rpc.rpcGateway("browser.request", { method, path, body, query: { profile: "openclaw", ...query }, timeoutMs: 40000 }, 45000);
  if (!frame.ok) throw new Error(frame.error?.message || "Browser RPC failed");
  return frame.payload;
};
rpc.start();
try {
  await rpc.waitUntilConnected(30000);
  await request("POST", "/start");
  const tab = await request("POST", "/tabs/open", { url: "https://example.com" });
  const targetId = tab.targetId;
  assert.ok(targetId);
  const evaluate = (fn) => request("POST", "/act", { kind: "evaluate", targetId, fn });
  if (process.argv.includes("--verify-persistence")) {
    const stored = await evaluate('() => localStorage.getItem("oneclaw-browser-smoke")');
    assert.equal(stored.result, "persisted");
    console.log("PASS: browser profile storage survived container restart");
  }
  await evaluate(`() => {
    localStorage.setItem("oneclaw-browser-smoke", "persisted");
    const panel = document.createElement("section");
    panel.style.cssText = "padding:32px;background:#eef6ff;color:#123;font:24px sans-serif";
    const title = document.createElement("h1"); title.textContent = "OneClaw 云端浏览器验证";
    const button = document.createElement("button"); button.textContent = "验证点击";
    button.onclick = () => { button.textContent = "点击成功"; document.title = "OneClaw browser verified"; };
    panel.append(title, button); document.body.prepend(panel);
    return true;
  }`);
  const snapshot = await request("GET", "/snapshot", undefined, { targetId, format: "ai" });
  const ref = Object.entries(snapshot.refs || {}).find(([, value]) => value.role === "button" && value.name === "验证点击")?.[0];
  assert.ok(ref, "snapshot must expose the button reference");
  await request("POST", "/act", { kind: "click", targetId, ref });
  const title = await evaluate("() => document.title");
  assert.equal(title.result, "OneClaw browser verified");
  await request("POST", "/tabs/focus", { targetId });
  const screenshot = await request("POST", "/screenshot", { targetId, type: "png" });
  assert.ok(screenshot.path);
  console.log(JSON.stringify({ ok: true, checks: ["start", "navigate", "snapshot", "click", "evaluate", "focus", "screenshot"], screenshot: screenshot.path }));
} finally { rpc.close(); }
