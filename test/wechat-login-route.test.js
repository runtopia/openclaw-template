import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { createRepairRouter } from "../src/repair/router.js";
import { stopWechatLogin } from "../src/channels/wechat-login.js";

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

function createWechatRepairApp() {
  const app = express();
  app.use(express.json());
  app.use("/repair", createRepairRouter({
    requireSetupAuth: (_req, _res, next) => next(),
    instanceSecret: undefined,
    runCmd: async () => ({ code: 0, output: "" }),
    clawArgs: (args) => args,
    OPENCLAW_NODE: "node",
    restartGateway: async () => ({ ok: true }),
    configFilePath: () => "/tmp/missing-openclaw.json",
    stateDir: "/tmp",
    gatewayTarget: "http://gateway.local",
    gatewayToken: "gateway-token",
    gatewayManager: {
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      ensureGatewayRunning: async () => ({ ok: true }),
      getRecentLogs: () => [],
    },
    getRepairAiKey: () => null,
    gatewayRpc: null,
  }));
  return app;
}

test("wechat login start uses plugin HTTP route and returns QR immediately", async (t) => {
  const originalFetch = globalThis.fetch;
  const pluginCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-start") {
      pluginCalls.push({ url: String(url), opts });
      assert.equal(opts.headers.Authorization, "Bearer gateway-token");
      assert.deepEqual(JSON.parse(opts.body), { accountId: "emp1" });
      return jsonResponse({
        sessionKey: "wechat-session-1",
        qrDataUrl: "https://liteapp.weixin.qq.com/q/test?qrcode=abc&bot_type=3",
        message: "使用微信扫描以下二维码，以完成连接。",
      });
    }
    return originalFetch(url, opts);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    stopWechatLogin();
  });

  const server = await listen(createWechatRepairApp());
  t.after(() => server.close());
  const { port } = server.address();

  const res = await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
  });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.status, "scan");
  assert.equal(data.qrUrl, "https://liteapp.weixin.qq.com/q/test?qrcode=abc&bot_type=3");
  assert.equal(data.sessionKey, "wechat-session-1");
  assert.equal(pluginCalls.length, 1);
});

test("wechat login start retries transient plugin QR failures once", async (t) => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-start") {
      attempts += 1;
      if (attempts === 1) {
        return jsonResponse({ error: "temporary upstream network error" }, 502);
      }
      return jsonResponse({
        sessionKey: "wechat-session-retry",
        qrDataUrl: "https://liteapp.weixin.qq.com/q/retry?qrcode=abc&bot_type=3",
        message: "使用微信扫描以下二维码，以完成连接。",
      });
    }
    return originalFetch(url, opts);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    stopWechatLogin();
  });

  const server = await listen(createWechatRepairApp());
  t.after(() => server.close());
  const { port } = server.address();

  const res = await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
  });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.qrUrl, "https://liteapp.weixin.qq.com/q/retry?qrcode=abc&bot_type=3");
  assert.equal(attempts, 2);
});
