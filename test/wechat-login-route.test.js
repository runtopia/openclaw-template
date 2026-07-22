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

function createWechatRepairApp(overrides = {}) {
  const app = express();
  app.use(express.json());
  app.use("/repair", createRepairRouter({
    requireSetupAuth: (_req, _res, next) => next(),
    instanceSecret: undefined,
    runCmd: async () => ({ code: 0, output: "" }),
    clawArgs: () => ["-e", "setTimeout(() => {}, 5000)"],
    OPENCLAW_NODE: process.execPath,
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
    ...overrides,
  }));
  return app;
}

test("wechat login start uses plugin HTTP route and returns QR immediately", async (t) => {
  const originalFetch = globalThis.fetch;
  const pluginCalls = [];
  const expiresAt = new Date(Date.now() + 300_000).toISOString();
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-start") {
      pluginCalls.push({ url: String(url), opts });
      assert.equal(opts.headers.Authorization, "Bearer gateway-token");
      assert.deepEqual(JSON.parse(opts.body), { accountId: "emp1", expiresAt });
      return jsonResponse({
        sessionKey: "wechat-session-1",
        qrDataUrl: "https://liteapp.weixin.qq.com/q/test?qrcode=abc&bot_type=3",
        qrExpiresAt: "2026-07-09T11:20:00.000Z",
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
    body: JSON.stringify({ accountId: "emp1", expiresAt }),
  });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.status, "scan");
  assert.equal(data.qrUrl, "https://liteapp.weixin.qq.com/q/test?qrcode=abc&bot_type=3");
  assert.equal(data.qrExpiresAt, "2026-07-09T11:20:00.000Z");
  assert.equal(data.sessionKey, "wechat-session-1");
  assert.equal(pluginCalls.length, 1);
});

test("wechat login status publishes a refreshed plugin QR", async (t) => {
  const originalFetch = globalThis.fetch;
  const initialQrUrl = "https://liteapp.weixin.qq.com/q/initial?qrcode=old&bot_type=3";
  const refreshedQrUrl = "https://liteapp.weixin.qq.com/q/refreshed?qrcode=new&bot_type=3";
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-start") {
      return jsonResponse({ sessionKey: "wechat-session-refresh", qrDataUrl: initialQrUrl });
    }
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-status?sessionKey=wechat-session-refresh") {
      return jsonResponse({
        status: "pending",
        qrDataUrl: refreshedQrUrl,
        qrUpdatedAt: "2026-07-10T03:00:00.000Z",
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

  await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
  });
  const statusRes = await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login`);
  const statusData = await statusRes.json();

  assert.equal(statusRes.status, 200);
  assert.equal(statusData.qrUrl, refreshedQrUrl);
  assert.equal(statusData.qrDataUrl, refreshedQrUrl);
  assert.equal(statusData.qrUpdatedAt, "2026-07-10T03:00:00.000Z");
});

test("wechat login stop cancels the active plugin session", async (t) => {
  const originalFetch = globalThis.fetch;
  const pluginStopCalls = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-start") {
      return jsonResponse({
        sessionKey: "wechat-session-stop",
        qrDataUrl: "https://liteapp.weixin.qq.com/q/stop?qrcode=abc&bot_type=3",
      });
    }
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-stop") {
      pluginStopCalls.push({ url: String(url), opts });
      return jsonResponse({ success: true, status: "cancelled" });
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

  await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
  });
  const stopRes = await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/stop`, {
    method: "POST",
  });

  assert.equal(stopRes.status, 200);
  assert.equal(pluginStopCalls.length, 1);
  assert.deepEqual(JSON.parse(pluginStopCalls[0].opts.body), {
    sessionKey: "wechat-session-stop",
  });
});

test("wechat login start reuses active plugin QR for the same account", async (t) => {
  const originalFetch = globalThis.fetch;
  let startCalls = 0;
  let statusCalls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-start") {
      startCalls += 1;
      assert.deepEqual(JSON.parse(opts.body), { accountId: "emp1" });
      return jsonResponse({
        sessionKey: "wechat-session-reuse",
        qrDataUrl: "https://liteapp.weixin.qq.com/q/reuse?qrcode=abc&bot_type=3",
        message: "使用微信扫描以下二维码，以完成连接。",
      });
    }
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-status?sessionKey=wechat-session-reuse") {
      statusCalls += 1;
      return jsonResponse({ status: "scan", message: "waiting" });
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

  const first = await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
  });
  const firstData = await first.json();
  const second = await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
  });
  const secondData = await second.json();

  assert.equal(firstData.qrUrl, "https://liteapp.weixin.qq.com/q/reuse?qrcode=abc&bot_type=3");
  assert.equal(secondData.qrUrl, firstData.qrUrl);
  assert.equal(startCalls, 1);
  assert.equal(statusCalls, 1);
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

test("wechat login start waits for the plugin route during gateway startup", async (t) => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-start") {
      attempts += 1;
      if (attempts < 3) return jsonResponse({ error: "Not Found" }, 404);
      return jsonResponse({
        sessionKey: "wechat-session-late-route",
        qrDataUrl: "https://liteapp.weixin.qq.com/q/late?qrcode=abc&bot_type=3",
      });
    }
    return originalFetch(url, opts);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    stopWechatLogin();
  });

  const server = await listen(createWechatRepairApp({
    wechatPluginStartupWaitMs: 50,
    wechatPluginStartupPollMs: 1,
  }));
  t.after(() => server.close());
  const { port } = server.address();

  const res = await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
  });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.qrUrl, "https://liteapp.weixin.qq.com/q/late?qrcode=abc&bot_type=3");
  assert.equal(attempts, 3);
});

test("wechat login start disables plugin HTTP route after the startup window and falls back to CLI", async (t) => {
  const originalFetch = globalThis.fetch;
  let pluginCalls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url) === "http://gateway.local/plugins/openclaw-weixin/qr-start") {
      pluginCalls += 1;
      return jsonResponse({ error: "Not Found" }, 404);
    }
    return originalFetch(url, opts);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    stopWechatLogin();
  });

  const server = await listen(createWechatRepairApp({
    wechatPluginStartupWaitMs: 5,
    wechatPluginStartupPollMs: 1,
  }));
  t.after(() => server.close());
  const { port } = server.address();

  for (let i = 0; i < 2; i += 1) {
    const res = await originalFetch(`http://127.0.0.1:${port}/repair/wechat-login/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: "emp1" }),
    });
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.ok, true);
  }

  assert.ok(pluginCalls > 1);
});
