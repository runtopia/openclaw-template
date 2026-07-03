// OpenClaw template wrapper — entry point.
//
// Responsibilities:
//   1. Resolve global constants (gateway token, ports, dirs)
//   2. Start sub-systems: OneClaw integration
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
import { createGatewayRpc } from "./lib/gateway-rpc.js";
import { createOneclawIntegration } from "./lib/oneclaw-integration.js";
import { autoConfigureFromEnv, hasAutoConfigEnvVars } from "./lib/auto-config.js";
import { hasAnyChannelConfig, reconcileAllChannels } from "./lib/channel-manifest.js";
import { ensureControlUiConfig } from "./lib/control-ui-config.js";
import { createSetupRouter } from "./lib/routes/setup.js";
import { createApiRouter } from "./lib/routes/api.js";
import { createTuiRouter } from "./lib/routes/tui.js";
import { createRepairRouter } from "./lib/routes/repair.js";
import { readDefaultProviderKey, readEnvProviderKey } from "./lib/repair-ai-key.js";
import { createRequireSetupAuth } from "./lib/routes/setup.js";
import { patchConfig } from "./lib/openclaw-config.js";
import { applyRuntimeDefaults } from "./lib/direct-config.js";
import { applyPreinstalledPluginInstallRecords, cleanupStalePreinstalledExtensions } from "./lib/preinstalled-plugins.js";

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

// Gateway RPC client — wrapper's own single WS connection to the gateway (for
// repair endpoints forwarding gateway RPCs like web.login). Frontend clients
// connect directly via the WS reverse proxy, each with its own handshake.
const gatewayRpc = createGatewayRpc({
  gatewayHost: INTERNAL_GATEWAY_HOST,
  gatewayPort: INTERNAL_GATEWAY_PORT,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  basePath: "/openclaw",
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
  patchConfig(configFilePath(), (cfg) => {
    if (applyPreinstalledPluginInstallRecords(cfg)) {
      console.log("[wrapper] patched preinstalled official plugin install records");
    }
    if (applyRuntimeDefaults(cfg, process.env)) {
      console.log("[wrapper] patched runtime defaults");
    }
  });
  ensureControlUiConfig({
    configPath: configFilePath(),
    port: process.env.PORT || PORT,
    internalGatewayHost: INTERNAL_GATEWAY_HOST,
    internalGatewayPort: INTERNAL_GATEWAY_PORT,
    allowedOriginsEnv: process.env.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS,
  });
}

// ──────────────────────────────────────────────────────────────
// Express app
// ──────────────────────────────────────────────────────────────

// 修复助手用的 AI key 解析顺序：先环境变量，再回退到 openclaw.json。
// env 优先让镜像部署在 auto-config 写文件之前就能用修复助手。
function resolveRepairAiKey() {
  return readEnvProviderKey(process.env)
      || readDefaultProviderKey(configFilePath());
}

let repairAiKey = resolveRepairAiKey();
if (repairAiKey) {
  console.log(`[repair] AI key loaded for provider: ${repairAiKey.providerName} (baseUrl=${repairAiKey.baseUrl})`);
} else {
  console.log("[repair] no AI key found in env or config — chat endpoint will return 503");
}
function refreshRepairAiKey() {
  repairAiKey = resolveRepairAiKey();
  console.log(`[repair] key refreshed: ${repairAiKey ? repairAiKey.providerName : "null"}`);
}

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
  configFilePath,
  port: PORT,
  internalGatewayHost: INTERNAL_GATEWAY_HOST,
  internalGatewayPort: INTERNAL_GATEWAY_PORT,
  ENABLE_WEB_TUI,
  TUI_IDLE_TIMEOUT_MS,
  TUI_MAX_SESSION_MS,
  onSetupComplete: refreshRepairAiKey,
});
app.use("/setup", setupRouter);

// Repair API (挂载在 /setup/api/repair/*)
const requireSetupAuth = createRequireSetupAuth(SETUP_PASSWORD);
const repairRouter = createRepairRouter({
  requireSetupAuth,
  instanceSecret: ONECLAW_INSTANCE_SECRET,
  runCmd,
  clawArgs,
  OPENCLAW_NODE,
  restartGateway: gateway.restartGateway,
  configFilePath,
  stateDir: STATE_DIR,
  gatewayManager: gateway,
  getRepairAiKey: () => repairAiKey,
  gatewayRpc,
});
app.use("/setup/api/repair", repairRouter);

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
  gatewayTarget: gateway.GATEWAY_TARGET,
});
app.use("/api", apiRouter);

// Media file serving (/media?path=<absolute-or-relative-path>)
// Serves files under STATE_DIR/media only. Requires gateway bearer token (header or query param).
app.get("/media", (req, res) => {
  const headerToken = (req.headers.authorization || "").replace("Bearer ", "").trim();
  const queryToken = String(req.query.token || "").trim();
  const token = headerToken || queryToken;
  if (!OPENCLAW_GATEWAY_TOKEN || token !== OPENCLAW_GATEWAY_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const rawPath = String(req.query.path || "");
  if (!rawPath) return res.status(400).json({ error: "Missing path" });

  // Resolve: accept absolute paths or relative to STATE_DIR
  const resolved = path.isAbsolute(rawPath) ? rawPath : path.join(STATE_DIR, rawPath);
  const mediaDir = path.join(STATE_DIR, "media");
  const normalized = path.normalize(resolved);

  // Security: must be inside STATE_DIR/media
  if (!normalized.startsWith(mediaDir + path.sep) && normalized !== mediaDir) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isFile()) {
    return res.status(404).json({ error: "Not found" });
  }

  const ext = path.extname(normalized).toLowerCase();
  const mimeMap = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    ".pdf": "application/pdf",
  };
  const contentType = mimeMap[ext] || "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "private, max-age=86400");
  fs.createReadStream(normalized).pipe(res);
});

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
const gatewayProxy = httpProxy.createProxyServer({ target: gateway.GATEWAY_TARGET, xfwd: true, changeOrigin: true, ws: true });
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
  cleanupStalePreinstalledExtensions(STATE_DIR);

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
      .then(async () => { gatewayRpc.start(); console.log("[wrapper] gateway started successfully at boot"); await oneclaw.sendHeartbeat(); })
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
        };
        const success = await autoConfigureFromEnv(ctx);
        console.log(`[wrapper] auto-config ${success ? "succeeded" : "failed"}`);
        if (isConfigured()) {
          refreshRepairAiKey();
          if (ONECLAW_TEMPLATE_ID) await oneclaw.applyTemplateFromEnv(ONECLAW_TEMPLATE_ID);
          await ensureWebSocketConfig();
          gateway.ensureGatewayRunning()
            .then(async () => { gatewayRpc.start(); console.log("[wrapper] gateway started successfully after auto-config"); await oneclaw.sendHeartbeat(); })
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

  // Reverse-proxy the WS upgrade straight to the gateway — each frontend client
  // gets its own gateway connection (connect handshake + subscriptions).
  gatewayProxy.ws(req, socket, head);
});

// ──────────────────────────────────────────────────────────────
// Graceful shutdown
// ──────────────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
  console.log(`[wrapper] received ${signal}, shutting down`);

  oneclaw.stop();
  gatewayRpc.close();
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
