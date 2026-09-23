import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
import { applyBrowserDefaults } from "../src/config/browser.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBrowserDesktop, cleanupStaleBrowserLocks } from "../src/browser/desktop.js";
import { createBrowserRoutes, startManagedBrowser } from "../src/browser/routes.js";

test("headed browser defaults enforce visible mode while preserving unrelated choices", () => {
  const cfg = { tools: { profile: "coding", alsoAllow: ["other"] } };
  assert.equal(applyBrowserDefaults(cfg, {}), false);
  assert.equal(applyBrowserDefaults(cfg, { ONECLAW_BROWSER_ENABLED: "1" }), true);
  assert.equal(cfg.browser.headless, false);
  assert.deepEqual(cfg.browser.extraArgs, ["--start-maximized", "--noerrdialogs"]);
  assert.deepEqual(cfg.tools.alsoAllow, ["other", "browser"]);
  assert.equal(applyBrowserDefaults(cfg, { ONECLAW_BROWSER_ENABLED: "1" }), false);
  cfg.browser.headless = true;
  cfg.browser.executablePath = "/custom/chrome";
  applyBrowserDefaults(cfg, { ONECLAW_BROWSER_ENABLED: "1" });
  assert.equal(cfg.browser.headless, false);
  assert.equal(cfg.browser.executablePath, "/custom/chrome");
  const disabled = { browser: { enabled: false } };
  assert.equal(applyBrowserDefaults(disabled, { ONECLAW_BROWSER_ENABLED: "1" }), false);
  const denied = { tools: { profile: "coding", deny: ["browser"] } };
  applyBrowserDefaults(denied, { ONECLAW_BROWSER_ENABLED: "1" });
  assert.equal(denied.tools.alsoAllow, undefined);
});

test("disabled desktop does not start processes or modify DISPLAY", async () => {
  const env = { DISPLAY: ":7" };
  const desktop = createBrowserDesktop({ env });
  await desktop.start();
  assert.equal(desktop.status().enabled, false);
  assert.equal(env.DISPLAY, ":7");
  desktop.stop();
});

async function fixture(t, options = {}) {
  const app = express();
  let starts = 0;
  const preview = createBrowserRoutes({
    desktop: { status: () => ({ enabled: true, ready: true }) },
    credentialsConfigured: true,
    isAuthed: (req) => req.headers.cookie === "valid=1",
    startBrowser: async () => { starts++; },
    ...options,
  });
  app.use("/browser", preview.router);
  const server = app.listen(0, "127.0.0.1");
  server.on("upgrade", (req, socket, head) => {
    if (!preview.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await once(server, "listening");
  t.after(() => { preview.close(); server.closeAllConnections(); server.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, starts: () => starts };
}

test("preview requires configured credentials and login; start requires same origin", async (t) => {
  const { base, starts } = await fixture(t);
  const unauth = await fetch(`${base}/browser/`, { redirect: "manual" });
  assert.equal(unauth.status, 302);
  const status = await fetch(`${base}/browser/status`, { headers: { cookie: "valid=1" } });
  assert.equal(status.status, 200);
  const denied = await fetch(`${base}/browser/start`, { method: "POST", headers: { cookie: "valid=1", origin: "https://attacker.test" } });
  assert.equal(denied.status, 403);
  assert.equal(starts(), 0);
  const started = await fetch(`${base}/browser/start`, { method: "POST", headers: { cookie: "valid=1", origin: base } });
  assert.equal(started.status, 200);
  assert.equal(starts(), 1);
  const noCredentials = await fixture(t, { credentialsConfigured: false });
  assert.equal((await fetch(`${noCredentials.base}/browser/status`, { headers: { cookie: "valid=1" } })).status, 503);
});

test("VNC upgrades enforce auth, origin and path and forward binary data without credentials", async (t) => {
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  t.after(() => { for (const ws of upstream.clients) ws.terminate(); upstream.close(); });
  let headers;
  upstream.on("connection", (ws, req) => { headers = req.headers; ws.on("message", (data) => ws.send(data)); });
  const { base } = await fixture(t, { target: `http://127.0.0.1:${upstream.address().port}` });
  for (const [path, cookie, origin, expected] of [
    ["/browser/ws", "bad", base, 401],
    ["/browser/ws", "valid=1", "https://attacker.test", 403],
    ["/browser/unknown", "valid=1", base, 404],
  ]) {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(base.replace("http", "ws") + path, { headers: { cookie, origin } });
      ws.on("unexpected-response", (_req, res) => { assert.equal(res.statusCode, expected); res.resume(); ws.terminate(); resolve(); });
      ws.on("open", () => reject(new Error("unexpected authorization")));
      ws.on("error", () => {});
    });
  }
  const ws = new WebSocket(base.replace("http", "ws") + "/browser/ws", { headers: { cookie: "valid=1", origin: base, authorization: "Bearer secret" } });
  await once(ws, "open");
  t.after(() => ws.terminate());
  const response = once(ws, "message");
  ws.send(Buffer.from([0, 1, 255]));
  assert.deepEqual((await response)[0], Buffer.from([0, 1, 255]));
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
});

test("browser additions preserve explicit allow lists and support per-agent coding profiles", () => {
  const cfg = { tools: { profile: "coding", allow: ["read"] }, agents: { list: [{ id: "worker", tools: { profile: "coding" } }] } };
  applyBrowserDefaults(cfg, { ONECLAW_BROWSER_ENABLED: "1" });
  assert.equal(cfg.tools.alsoAllow, undefined);
  assert.deepEqual(cfg.tools.allow, ["read"]);
  assert.deepEqual(cfg.agents.list[0].tools.alsoAllow, ["browser"]);
  const disabled = { plugins: { entries: { browser: { enabled: false } } } };
  const before = structuredClone(disabled);
  assert.equal(applyBrowserDefaults(disabled, { ONECLAW_BROWSER_ENABLED: "1" }), false);
  assert.deepEqual(disabled, before);
});


test("browser start waits for connection and surfaces Gateway failure frames", async () => {
  let connected = false;
  const rpc = {
    waitUntilConnected: async () => { connected = true; },
    rpcGateway: async () => { assert.equal(connected, true); return { ok: false, error: { message: "sandbox unavailable" } }; },
  };
  await assert.rejects(startManagedBrowser(rpc), /sandbox unavailable/);
  rpc.rpcGateway = async () => ({ ok: true, payload: { running: true } });
  assert.deepEqual(await startManagedBrowser(rpc), { running: true });
});


test("redeploy clears dead Chromium symlinks but preserves live sockets and profile data", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-locks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "browser/openclaw/user-data");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Preferences"), "keep");
  fs.symlinkSync("old-container-123", path.join(dir, "SingletonLock"));
  const socket = path.join(root, "old-socket");
  fs.writeFileSync(socket, "live");
  fs.symlinkSync(socket, path.join(dir, "SingletonSocket"));
  assert.equal(cleanupStaleBrowserLocks(root), false);
  fs.unlinkSync(socket);
  assert.equal(cleanupStaleBrowserLocks(root), true);
  assert.equal(fs.readFileSync(path.join(dir, "Preferences"), "utf8"), "keep");
  assert.equal(fs.readdirSync(dir).includes("SingletonLock"), false);
});

test("Browser Use resolves the locked package path instead of the prototype mount", () => {
  const cfg = {};
  const env = { ONECLAW_BROWSER_ENABLED: "1", ONECLAW_BROWSER_USE_ENABLED: "1" };
  applyBrowserDefaults(cfg, env);
  assert.equal(cfg.plugins.entries["oneclaw-browser-use"].enabled, true);
  assert.deepEqual(cfg.plugins.load.paths, ["/opt/openclaw-plugins/node_modules/@oneclaw-plugins/browser-use"]);
  assert.equal(applyBrowserDefaults(cfg, env), false);
  const custom = {};
  applyBrowserDefaults(custom, { ...env, OPENCLAW_PLUGINS_DIR: "/tmp/bundle" });
  assert.equal(custom.plugins.load.paths[0], "/tmp/bundle/node_modules/@oneclaw-plugins/browser-use");
});


test("headed mode removes launch overrides from persisted config", () => {
  const cfg = { browser: { headless: true, extraArgs: ["--headless=new", "--display=:7", "--lang=zh-CN", "--ozone-platform", "headless"], profiles: { openclaw: { headless: true, cdpPort: 18800, color: "#FF4500" }, work: { headless: true } } } };
  const env = { ONECLAW_BROWSER_ENABLED: "1" };
  applyBrowserDefaults(cfg, env);
  assert.equal(cfg.browser.headless, false);
  assert.equal(cfg.browser.profiles.openclaw.headless, false);
  assert.deepEqual(cfg.browser.extraArgs, ["--lang=zh-CN"]);
  assert.equal(cfg.browser.profiles.openclaw.cdpPort, 18800);
  assert.equal(cfg.browser.profiles.work.headless, true);
  assert.equal(applyBrowserDefaults(cfg, env), false);
});

test("coding agents can share Browser Use links unless explicitly denied", () => {
  const env = { ONECLAW_BROWSER_ENABLED: "1", ONECLAW_BROWSER_USE_ENABLED: "1" };
  const cfg = { tools: { profile: "coding" } };
  applyBrowserDefaults(cfg, env);
  assert.deepEqual(cfg.tools.alsoAllow, ["browser", "browser_use"]);
  const denied = { tools: { profile: "coding", deny: ["browser_use"] } };
  applyBrowserDefaults(denied, env);
  assert.deepEqual(denied.tools.alsoAllow, ["browser"]);
});
