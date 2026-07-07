import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { createRepairRouter } from "../src/repair/router.js";
import { createBrowserSessionManager } from "../src/proxy/browser-session.js";

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("repair openclaw-login issues one-time browser cookie login url without exposing gateway token", async (t) => {
  const app = express();
  app.use(express.json());
  const manager = createBrowserSessionManager({
    signSession: () => "signed-session",
    authCookie: "ocsess",
    port: 8080,
    ttlMs: 60_000,
  });
  app.get("/oneclaw-login", (req, res) => manager.handleLogin(req, res));
  app.use("/repair", createRepairRouter({
    requireSetupAuth: (_req, res) => res.status(401).json({ ok: false, error: "unauthorized" }),
    instanceSecret: "instance-secret",
    issueBrowserLoginUrl: (req, next) => manager.issueLoginUrl(req, next),
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
    gatewayRpc: null,
  }));

  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();

  const unauth = await fetch(`http://127.0.0.1:${port}/repair/openclaw-login`, { method: "POST" });
  assert.equal(unauth.status, 401);

  const res = await fetch(`http://127.0.0.1:${port}/repair/openclaw-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer instance-secret" },
    body: JSON.stringify({ next: "/openclaw/chat" }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.match(data.url, /^http:\/\/127\.0\.0\.1:\d+\/oneclaw-login\?ticket=oclt_/);
  assert.equal(data.url.includes("gateway"), false);

  const login = await fetch(data.url, { redirect: "manual" });
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("location"), "/openclaw/chat");
  const cookie = login.headers.get("set-cookie") || "";
  assert.match(cookie, /ocsess=signed-session/);
  assert.match(cookie, /HttpOnly/);

  const reused = await fetch(data.url, { redirect: "manual" });
  assert.equal(reused.status, 401);
});

test("browser cookie login uses cross-site cookie attributes behind https proxy", async (t) => {
  const app = express();
  app.use(express.json());
  const manager = createBrowserSessionManager({
    signSession: () => "signed-session",
    authCookie: "ocsess",
    port: 8080,
    ttlMs: 60_000,
  });
  app.get("/oneclaw-login", (req, res) => manager.handleLogin(req, res));
  app.use("/repair", createRepairRouter({
    requireSetupAuth: (_req, res) => res.status(401).json({ ok: false, error: "unauthorized" }),
    instanceSecret: "instance-secret",
    issueBrowserLoginUrl: (req, next) => manager.issueLoginUrl(req, next),
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
    gatewayRpc: null,
  }));

  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/repair/openclaw-login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer instance-secret",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "runtime.example.com",
    },
    body: JSON.stringify({ next: "/health" }),
  });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.match(data.url, /^https:\/\/runtime\.example\.com\/oneclaw-login\?ticket=oclt_/);

  const localLoginUrl = data.url.replace("https://runtime.example.com", `http://127.0.0.1:${port}`);
  const login = await fetch(localLoginUrl, {
    redirect: "manual",
    headers: { "x-forwarded-proto": "https" },
  });
  const cookie = login.headers.get("set-cookie") || "";
  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);
});
