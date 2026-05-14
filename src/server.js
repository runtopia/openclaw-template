// OpenClaw template wrapper — entry point.
//
// Responsibilities:
//   1. Resolve global constants (gateway token, ports, dirs)
//   2. Start sub-systems: ClawRouters proxy, OneClaw integration
//   3. Wire Express app: setup wizard, API routes, TUI, gateway reverse proxy
//   4. Startup orchestration:
//      a. If already configured: reconcile channels → ensure gateway running
//      b. If not configured + AI keys present: auto-configure → start gateway
//   5. Handle WebSocket upgrades (gateway pass-through)
//   6. Graceful shutdown

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";

import { createGatewayManager } from "./lib/gateway.js";
import { startClawRoutersProxy } from "./lib/cr-proxy.js";
import { createOneclawIntegration } from "./lib/oneclaw-integration.js";
import { autoConfigureFromEnv, hasAutoConfigEnvVars } from "./lib/auto-config.js";
import { hasAnyChannelConfig, reconcileAllChannels } from "./lib/channel-manifest.js";
import { createSetupRouter } from "./lib/routes/setup.js";
import { createApiRouter } from "./lib/routes/api.js";
import { createTuiRouter } from "./lib/routes/tui.js";

// ──────────────────────────────────────────────────────────────
// Constants
// ──────────────────────────────────────────────────────────────

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

const INTERNAL_GATEWAY_PORT = Number.parseInt(process.env.INTERNAL_GATEWAY_PORT ?? "18789", 10);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";

const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(process.env.TUI_IDLE_TIMEOUT_MS ?? "300000", 10);
const TUI_MAX_SESSION_MS = Number.parseInt(process.env.TUI_MAX_SESSION_MS ?? "1800000", 10);

const ONECLAW_API_URL = process.env.ONECLAW_API_URL?.trim() || "https://www.oneclaw.net/api";
const ONECLAW_INSTANCE_ID = process.env.ONECLAW_INSTANCE_ID?.trim();
const ONECLAW_INSTANCE_SECRET = process.env.ONECLAW_INSTANCE_SECRET?.trim();
const ONECLAW_TEMPLATE_ID = process.env.ONECLAW_TEMPLATE_ID?.trim() || null;
const ONECLAW_END_USER = process.env.ONECLAW_END_USER?.trim() || "";

const CR_PROXY_PORT = Number.parseInt(process.env.CR_PROXY_PORT ?? "18791", 10);

// ──────────────────────────────────────────────────────────────
// Gateway token — stable across restarts (persisted to disk)
// ──────────────────────────────────────────────────────────────

function resolveGatewayToken() {
  const envTok = (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN)?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {}

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(`[gateway-token] could not persist token: ${err.code || err.message}`);
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

// ──────────────────────────────────────────────────────────────
// Shared helpers
// ──────────────────────────────────────────────────────────────

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configFilePath() {
  return process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(STATE_DIR, "openclaw.json");
}

function isConfigured() {
  try {
    const cfg = configFilePath();
    if (!fs.existsSync(cfg)) return false;
    // Distinguish a fully onboarded instance from two false positives:
    //   1. `openclaw plugins install` (boot-time) creates a minimal config
    //      containing only `plugins.entries` + `meta`.
    //   2. `doctor --fix` may auto-add `gateway.auth` to that minimal config
    //      but does NOT add `gateway.mode`. Onboard always writes `gateway.mode`.
    // So `gateway.mode` is the only field that cleanly says "user is onboarded".
    const data = JSON.parse(fs.readFileSync(cfg, "utf8"));
    return Boolean(data?.gateway?.mode);
  } catch {
    return false;
  }
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: { ...process.env, OPENCLAW_STATE_DIR: STATE_DIR, OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR },
    });
    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));
    proc.on("error", (err) => { out += `\n[spawn error] ${String(err)}\n`; resolve({ code: 127, output: out }); });
    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

// ──────────────────────────────────────────────────────────────
// Sub-systems
// ──────────────────────────────────────────────────────────────

// ClawRouters loopback proxy (no-op when ONECLAW_END_USER is empty)
const crProxy = startClawRoutersProxy({ port: CR_PROXY_PORT, endUser: ONECLAW_END_USER });
const CR_PROXY_BASE_URL = crProxy?.baseUrl || null;

// Gateway manager
const gateway = createGatewayManager({
  OPENCLAW_NODE,
  clawArgs,
  stateDir: STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  internalGatewayPort: INTERNAL_GATEWAY_PORT,
  internalGatewayHost: INTERNAL_GATEWAY_HOST,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  isConfigured,
});

// OneClaw integration (heartbeat, events, personality, reminders)
const oneclaw = createOneclawIntegration({
  apiUrl: ONECLAW_API_URL,
  instanceId: ONECLAW_INSTANCE_ID,
  instanceSecret: ONECLAW_INSTANCE_SECRET,
  workspaceDir: WORKSPACE_DIR,
  gatewayTarget: gateway.GATEWAY_TARGET,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  isGatewayReady: gateway.isGatewayReady,
  isGatewayStarting: gateway.isGatewayStarting,
});

// ──────────────────────────────────────────────────────────────
// Startup config fixes (existing instances)
// ──────────────────────────────────────────────────────────────

async function ensureWebSocketConfig() {
  if (!isConfigured()) return;
  try {
    console.log("[startup-fix] ensuring allowInsecureAuth=true...");
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]));

    // Patch openclaw.json directly for dangerouslyDisableDeviceAuth
    const configPath = configFilePath();
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config.gateway) {
        if (!config.gateway.controlUi) config.gateway.controlUi = {};
        config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
        config.gateway.controlUi.allowInsecureAuth = true;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log("[startup-fix] patched openclaw.json: dangerouslyDisableDeviceAuth=true");
      }
    }

    // Start from existing origins in config (if any) so we don't overwrite
    // origins set by the setup wizard (e.g. localhost:PORT).
    let existingOrigins = [];
    try {
      const raw = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", "gateway.controlUi.allowedOrigins"]));
      if (raw.code === 0 && raw.output) existingOrigins = JSON.parse(raw.output.trim());
    } catch {}
    if (!Array.isArray(existingOrigins)) existingOrigins = [];

    // Merge env override or inject localhost defaults
    const ALLOWED_ORIGINS_ENV = process.env.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS?.trim();
    if (ALLOWED_ORIGINS_ENV) {
      const list = ALLOWED_ORIGINS_ENV.split(",").map((o) => o.trim()).filter(Boolean);
      existingOrigins = [...list];
      console.log(`[startup-fix] using allowedOrigins from env: ${existingOrigins}`);
    } else {
      // Always ensure localhost is whitelisted so local WebTUI works
      const localUrls = [
        `http://localhost:${process.env.PORT || 8080}`,
        `http://127.0.0.1:${process.env.PORT || 8080}`,
      ];
      for (const url of localUrls) {
        if (!existingOrigins.includes(url)) existingOrigins.push(url);
      }
      // Ensure oneclaw.net origins are also present
      for (const url of ["https://oneclaw.net", "https://www.oneclaw.net"]) {
        if (!existingOrigins.includes(url)) existingOrigins.push(url);
      }
    }
    const origins = JSON.stringify(existingOrigins);
    console.log("[startup-fix] ensuring WebSocket allowedOrigins config...");
    const result = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.controlUi.allowedOrigins", origins]));
    console.log(`[startup-fix] WebSocket allowedOrigins configured (exit=${result.code})`);
    if (result.output) console.log(result.output);
  } catch (err) {
    console.warn(`[startup-fix] failed to set config: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────
// Express app
// ──────────────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Setup wizard (mounts at /setup/*)
const setupRouter = createSetupRouter({
  SETUP_PASSWORD,
  OPENCLAW_NODE,
  clawArgs,
  runCmd,
  isConfigured,
  ensureGatewayRunning: gateway.ensureGatewayRunning,
  restartGateway: gateway.restartGateway,
  stateDir: STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  ENABLE_WEB_TUI,
  TUI_IDLE_TIMEOUT_MS,
  TUI_MAX_SESSION_MS,
});
app.use("/setup", setupRouter);

// API routes (/api/*)
const apiRouter = createApiRouter({
  OPENCLAW_NODE,
  clawArgs,
  runCmd,
  isConfigured,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  instanceSecret: ONECLAW_INSTANCE_SECRET,
  instanceId: ONECLAW_INSTANCE_ID,
  trackMessage: oneclaw.trackMessage,
  fetchPersonality: oneclaw.fetchPersonality,
  applyPersonality: oneclaw.applyPersonality,
  isGatewayReady: gateway.isGatewayReady,
  isGatewayStarting: gateway.isGatewayStarting,
});
app.use("/api", apiRouter);

// TUI route (/tui)
const tuiRouter = createTuiRouter({
  ENABLE_WEB_TUI,
  OPENCLAW_NODE,
  clawArgs,
  isConfigured,
  workspaceDir: WORKSPACE_DIR,
  stateDir: STATE_DIR,
  TUI_IDLE_TIMEOUT_MS,
  TUI_MAX_SESSION_MS,
});
app.use("/tui", tuiRouter);

// Gateway reverse proxy (catch-all)
const gatewayProxy = httpProxy.createProxyServer({ target: gateway.GATEWAY_TARGET, ws: true, xfwd: true });
gatewayProxy.on("error", (err) => console.error("[proxy]", err));
// Rewrite Origin to the gateway's own host so gateway.controlUi.allowedOrigins
// never has to know about the wrapper's external URL (localhost, *.up.railway.app,
// custom domain, …). The wrapper enforces auth via the bearer token injected
// below, which the browser only has via URL fragment — cross-origin pages
// cannot obtain it. So this Origin rewrite does not weaken security.
const GATEWAY_ORIGIN = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;
gatewayProxy.on("proxyReq", (proxyReq) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", GATEWAY_ORIGIN);
});
gatewayProxy.on("proxyReqWs", (proxyReq) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", GATEWAY_ORIGIN);
});

app.use(async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }
  // OpenClaw Control UI references `favicon.svg` with a relative path. On
  // sub-routes like /openclaw/chat the browser resolves it to
  // /openclaw/favicon.svg, which gateway does not serve. Rewrite to root.
  if (req.path === "/openclaw/favicon.svg") {
    req.url = "/favicon.svg";
  }
  if (isConfigured()) {
    if (gateway.isGatewayStarting() && !gateway.isGatewayReady()) {
      return res.sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
    }
    try {
      await gateway.ensureGatewayRunning();
    } catch (err) {
      return res.status(503).type("text/plain").send(`Gateway not ready: ${String(err)}`);
    }
  }
  if (req.path === "/openclaw" && !req.query.token) {
    return res.redirect(`/openclaw?token=${OPENCLAW_GATEWAY_TOKEN}`);
  }
  // 已配置实例:根路径直接进 WebUI
  if (req.path === "/" && isConfigured()) {
    return res.redirect("/openclaw");
  }
  // 聊天 UI 需要 gatewayUrl (query) + token (fragment) 才能建立 WebSocket 连接
  if (req.path === "/openclaw/chat" && !req.query.gatewayUrl) {
    const xfProto = req.headers["x-forwarded-proto"];
    const proto = (typeof xfProto === "string" ? xfProto.split(",")[0].trim() : xfProto) || req.protocol || "http";
    const wsProto = proto === "https" ? "wss" : "ws";
    const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
    const gatewayUrl = `${wsProto}://${host}/openclaw`;
    const url = new URL(req.originalUrl || req.url, `http://${host}`);
    url.searchParams.set("gatewayUrl", gatewayUrl);
    return res.redirect(`${url.pathname}${url.search}#token=${OPENCLAW_GATEWAY_TOKEN}`);
  }
  return gatewayProxy.web(req, res, { target: gateway.GATEWAY_TARGET });
});

// ──────────────────────────────────────────────────────────────
// Startup orchestration
// ──────────────────────────────────────────────────────────────

const server = app.listen(PORT, async () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  console.log(`[wrapper] OneClaw heartbeat: ${ONECLAW_INSTANCE_ID ? "enabled" : "disabled"}`);

  if (ONECLAW_INSTANCE_ID) {
    oneclaw.start();
  }

  const configured = isConfigured();
  console.log(`[wrapper] configured: ${configured}`);

  if (configured && hasAnyChannelConfig()) {
    // Re-deploy reconciliation: force channels into dmPolicy=open so users
    // never see a pairing prompt after a Railway redeploy on a persisted volume.
    console.log("[wrapper] already configured — running channel reconcile pass");
    try {
      await reconcileAllChannels({
        env: process.env,
        stateDir: STATE_DIR,
        OPENCLAW_NODE,
        clawArgs,
        runCmd,
      });
      console.log("[wrapper] reconcile complete; gateway will boot with fresh config");
    } catch (err) {
      console.error(`[wrapper] reconcile failed: ${err.message}`);
    }
  }

  if (configured) {
    if (ONECLAW_TEMPLATE_ID) await oneclaw.applyTemplateFromEnv(ONECLAW_TEMPLATE_ID);
    await ensureWebSocketConfig();
    gateway.ensureGatewayRunning()
      .then(() => console.log("[wrapper] gateway started successfully at boot"))
      .catch((err) => console.error(`[wrapper] failed to start gateway at boot: ${err.message}`));
    return;
  }

  // Not yet configured — auto-configure if AI keys are present
  if (hasAutoConfigEnvVars()) {
    console.log("[wrapper] scheduling auto-configuration from env vars...");
    setTimeout(async () => {
      try {
        console.log("[wrapper] starting auto-configuration...");
        const ctx = {
          isConfigured,
          env: process.env,
          workspaceDir: WORKSPACE_DIR,
          stateDir: STATE_DIR,
          internalGatewayPort: INTERNAL_GATEWAY_PORT,
          gatewayToken: OPENCLAW_GATEWAY_TOKEN,
          OPENCLAW_NODE,
          clawArgs,
          runCmd,
          crProxyBaseUrl: CR_PROXY_BASE_URL,
        };
        const success = await autoConfigureFromEnv(ctx);
        console.log(`[wrapper] auto-config ${success ? "succeeded" : "failed"}`);
        if (isConfigured()) {
          if (ONECLAW_TEMPLATE_ID) await oneclaw.applyTemplateFromEnv(ONECLAW_TEMPLATE_ID);
          await ensureWebSocketConfig();
          gateway.ensureGatewayRunning()
            .then(() => console.log("[wrapper] gateway started successfully after auto-config"))
            .catch((err) => console.error(`[wrapper] failed to start gateway after auto-config: ${err.message}`));
        }
      } catch (err) {
        console.error(`[wrapper] auto-config failed: ${err.message}`);
      }
    }, 1000); // 1s delay lets health check pass first
  }
});

// ──────────────────────────────────────────────────────────────
// WebSocket upgrade handler
// ──────────────────────────────────────────────────────────────

// TUI WebSocket is wired up inside tuiRouter
tuiRouter.createWebSocketServer(server, { verifyTuiAuth: setupRouter.verifyTuiAuth });

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/tui/ws") return; // handled by tuiRouter's WebSocket server

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await gateway.ensureGatewayRunning();
  } catch (err) {
    console.warn(`[websocket] gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  gatewayProxy.ws(req, socket, head, { target: gateway.GATEWAY_TARGET });
});

// ──────────────────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
  console.log(`[wrapper] received ${signal}, shutting down`);

  oneclaw.stop();
  await oneclaw.sendEvent("instance_stopping", { signal });

  setupRouter.cleanup();

  const tuiSession = tuiRouter.getActiveTuiSession();
  if (tuiSession) {
    try { tuiSession.ws.close(1001, "Server shutting down"); tuiSession.pty?.kill(); } catch {}
  }

  server.close();
  gateway.stopGateway();

  const gatewayProc = gateway.getGatewayProc();
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (!gatewayProc.killed) gatewayProc.kill("SIGKILL");
    } catch (err) {
      console.warn(`[wrapper] error killing gateway: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
