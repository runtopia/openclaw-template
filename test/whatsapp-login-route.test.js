import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { createRepairRouter } from "../src/lib/routes/repair.js";

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("whatsapp login start returns preparing while gateway is warming up", async (t) => {
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
    gatewayManager: {
      isGatewayReady: () => false,
      isGatewayStarting: () => true,
      ensureGatewayRunning: () => new Promise(() => {}),
      getRecentLogs: () => [],
    },
    getRepairAiKey: () => null,
    gatewayRpc: {
      start() {},
      waitUntilConnected: async () => {
        throw new Error("gateway WS not connected");
      },
      rpcGateway: async () => {
        throw new Error("should not call rpc while warming up");
      },
    },
  }));

  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/repair/whatsapp-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
    signal: AbortSignal.timeout(500),
  });
  const data = await res.json();

  assert.equal(res.status, 202);
  assert.equal(data.ok, true);
  assert.equal(data.connected, false);
  assert.equal(data.qrDataUrl, null);
});

test("whatsapp login waits for gateway rpc and returns qr when startup finishes quickly", async (t) => {
  const app = express();
  app.use(express.json());
  let waitCalled = false;
  let rpcCalled = false;
  app.use("/repair", createRepairRouter({
    requireSetupAuth: (_req, _res, next) => next(),
    instanceSecret: undefined,
    runCmd: async () => ({ code: 0, output: "" }),
    clawArgs: (args) => args,
    OPENCLAW_NODE: "node",
    restartGateway: async () => ({ ok: true }),
    configFilePath: () => "/tmp/missing-openclaw.json",
    stateDir: "/tmp",
    gatewayManager: {
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      ensureGatewayRunning: async () => ({ ok: true }),
      getRecentLogs: () => [],
    },
    getRepairAiKey: () => null,
    gatewayRpc: {
      start() {},
      waitUntilConnected: async () => {
        waitCalled = true;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      rpcGateway: async (method, params) => {
        rpcCalled = true;
        assert.equal(method, "web.login.start");
        assert.equal(params.accountId, "emp1");
        return { ok: true, payload: { qrDataUrl: "data:image/png;base64,abc", connected: false } };
      },
    },
  }));

  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/repair/whatsapp-login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: "emp1" }),
  });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(waitCalled, true);
  assert.equal(rpcCalled, true);
  assert.equal(data.ok, true);
  assert.equal(data.connected, false);
  assert.equal(data.qrDataUrl, "data:image/png;base64,abc");
});
