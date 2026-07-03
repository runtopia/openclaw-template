import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createRepairRouter } from "../src/repair/router.js";

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
    signal: AbortSignal.timeout(2_500),
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

test("whatsapp login waits through a brief gateway warmup and returns qr", async (t) => {
  const app = express();
  app.use(express.json());
  let ready = false;
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
      isGatewayReady: () => ready,
      isGatewayStarting: () => !ready,
      ensureGatewayRunning: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        ready = true;
        return { ok: true };
      },
      getRecentLogs: () => [],
    },
    getRepairAiKey: () => null,
    gatewayRpc: {
      start() {},
      waitUntilConnected: async () => {},
      rpcGateway: async (method, params) => {
        assert.equal(method, "web.login.start");
        assert.equal(params.accountId, "emp1");
        return { ok: true, payload: { qrDataUrl: "data:image/png;base64,warm", connected: false } };
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
  assert.equal(data.ok, true);
  assert.equal(data.connected, false);
  assert.equal(data.qrDataUrl, "data:image/png;base64,warm");
});

test("repair restart does not restart gateway rpc again when gateway restart is coalesced", async (t) => {
  const app = express();
  app.use(express.json());
  let rpcRestartCalls = 0;
  app.use("/repair", createRepairRouter({
    requireSetupAuth: (_req, _res, next) => next(),
    instanceSecret: undefined,
    runCmd: async () => ({ code: 0, output: "" }),
    clawArgs: (args) => args,
    OPENCLAW_NODE: "node",
    restartGateway: async () => ({ ok: true, pending: true, coalesced: true }),
    configFilePath: () => "/tmp/missing-openclaw.json",
    stateDir: "/tmp",
    gatewayManager: {
      isGatewayReady: () => false,
      isGatewayStarting: () => true,
      ensureGatewayRunning: async () => ({ ok: true }),
      getRecentLogs: () => [],
    },
    getRepairAiKey: () => null,
    gatewayRpc: {
      restart() {
        rpcRestartCalls += 1;
      },
    },
  }));

  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/repair/restart`, { method: "POST" });
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(rpcRestartCalls, 0);
});

test("whatsapp login status detects oauth whatsapp account credentials", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-wa-state-"));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const accountDir = path.join(stateDir, "oauth", "whatsapp", "emp1");
  fs.mkdirSync(accountDir, { recursive: true });
  fs.writeFileSync(path.join(accountDir, "creds.json"), JSON.stringify({ registrationId: 1234 }), "utf8");

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
    stateDir,
    gatewayManager: {
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      ensureGatewayRunning: async () => ({ ok: true }),
      getRecentLogs: () => [],
    },
    getRepairAiKey: () => null,
    gatewayRpc: null,
  }));

  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/repair/whatsapp-login/status`);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.connected, true);
  assert.deepEqual(data.accountDirs, [{ accountId: "emp1", hasCredentials: true }]);
  assert.deepEqual(data.credentialFiles, ["oauth/whatsapp/emp1/creds.json"]);
});

test("whatsapp login diagnostics reports plugin, account, and relevant log evidence", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-wa-diag-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const stateDir = path.join(tmpDir, "state");
  const pluginDir = path.join(tmpDir, "plugins", "node_modules", "@openclaw", "whatsapp");
  const cfgPath = path.join(tmpDir, "openclaw.json");
  fs.mkdirSync(path.join(stateDir, "oauth", "whatsapp", "emp1"), { recursive: true });
  fs.writeFileSync(path.join(stateDir, "oauth", "whatsapp", "emp1", "creds.json"), JSON.stringify({ registrationId: 4321 }), "utf8");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "package.json"), JSON.stringify({ name: "@openclaw/whatsapp", version: "2026.6.11" }), "utf8");
  fs.writeFileSync(cfgPath, JSON.stringify({
    channels: {
      whatsapp: {
        enabled: true,
        dmPolicy: "pairing",
        accounts: { emp1: { enabled: true } },
      },
    },
    bindings: [{ agentId: "agent1", match: { channel: "whatsapp", accountId: "emp1" } }],
    plugins: {
      entries: { whatsapp: { enabled: true } },
      installs: { whatsapp: { installPath: pluginDir, version: "2026.6.11" } },
    },
  }), "utf8");

  const app = express();
  app.use(express.json());
  app.use("/repair", createRepairRouter({
    requireSetupAuth: (_req, _res, next) => next(),
    instanceSecret: undefined,
    runCmd: async () => ({ code: 0, output: "" }),
    clawArgs: (args) => args,
    OPENCLAW_NODE: "node",
    restartGateway: async () => ({ ok: true }),
    configFilePath: () => cfgPath,
    stateDir,
    gatewayManager: {
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      ensureGatewayRunning: async () => ({ ok: true }),
      getRecentLogs: () => [
        "unrelated",
        "[gateway] signal SIGTERM received",
        "[whatsapp] Failed to get QR: Timed out waiting for WhatsApp QR",
      ],
    },
    getRepairAiKey: () => null,
    gatewayRpc: {
      getConnectionState: () => ({
        connected: false,
        startupRetrying: true,
        startupRetryCount: 12,
        startupRetryElapsedMs: 45_000,
        lastHandshakeError: {
          code: "UNAVAILABLE",
          details: { reason: "startup-sidecars" },
        },
      }),
    },
  }));

  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/repair/whatsapp-login/diagnostics`);
  const data = await res.json();

  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.gateway.ready, true);
  assert.equal(data.gateway.rpc.startupRetrying, true);
  assert.equal(data.gateway.rpc.startupRetryCount, 12);
  assert.equal(data.plugin.installPathExists, true);
  assert.equal(data.plugin.packageVersion, "2026.6.11");
  assert.deepEqual(data.accounts.configuredAccountIds, ["emp1"]);
  assert.deepEqual(data.accounts.auth.accountDirs, [{ accountId: "emp1", hasCredentials: true }]);
  assert.equal(data.logs.length, 2);
});
