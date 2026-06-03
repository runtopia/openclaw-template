// sidecar.js — PID 1 进程
//
// 职责：
//   1. 启动时调用 init-config.js 逻辑写好 openclaw.json
//   2. spawn openclaw gateway run（内部端口 18789，loopback）作为子进程
//   3. 管理 gateway 生命周期：崩溃自愈、主动重启
//   4. 对外监听 $PORT，提供：
//      - /health        → 自身健康（即使 openclaw 挂了仍然 200）
//      - /repair/*      → 修复助手 API（含 AI chat）
//      - 其他所有请求   → 反向代理到 openclaw:18789
//
// 这样 Railway healthcheck 永远打得通，openclaw 崩溃时修复助手仍可访问。

import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";

import { createGatewayManager } from "./lib/gateway.js";
import { createOneclawIntegration } from "./lib/oneclaw-integration.js";
import { createRepairRouter } from "./lib/routes/repair.js";
import { createRequireSetupAuth } from "./lib/routes/setup.js";
import { readEnvProviderKey, readDefaultProviderKey } from "./lib/repair-ai-key.js";
import { generateConfigDirect } from "./lib/direct-config.js";
import { patchConfig, setIn } from "./lib/openclaw-config.js";
import { reconcileAllChannels } from "./lib/channel-manifest.js";
import { resolvePreinstalledPluginPaths } from "./lib/preinstalled-plugins.js";

// ── 常量 ──────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8080);                           // 对外端口（Railway $PORT）
const GATEWAY_PORT = Number(process.env.INTERNAL_GATEWAY_PORT ?? 18789); // openclaw 내部端口
const GATEWAY_HOST = "127.0.0.1";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");
const CONFIG_PATH = path.join(STATE_DIR, "openclaw.json");

const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRY?.trim() || "/usr/local/lib/node_modules/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

// OneClaw 平台集成参数
const ONECLAW_API_URL      = process.env.ONECLAW_API_URL?.trim()      || "https://www.oneclaw.net/api";
const ONECLAW_INSTANCE_ID  = process.env.ONECLAW_INSTANCE_ID?.trim();
const ONECLAW_INSTANCE_SECRET = process.env.ONECLAW_INSTANCE_SECRET?.trim();
const ONECLAW_TEMPLATE_ID  = process.env.ONECLAW_TEMPLATE_ID?.trim()  || null;

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

// ── Gateway token ─────────────────────────────────────────────────────────────

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
    console.warn(`[sidecar] could not persist token: ${err.message}`);
  }
  return generated;
}

const GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = GATEWAY_TOKEN;

// ── 辅助 ──────────────────────────────────────────────────────────────────────

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function isConfigured() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return false;
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Boolean(data?.gateway?.mode);
  } catch { return false; }
}

function hasApiKeys(env = process.env) {
  return !!(
    env.ANTHROPIC_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() ||
    env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || env.DEEPSEEK_API_KEY?.trim() ||
    env.OPENROUTER_API_KEY?.trim() || env.CLAWROUTERS_KEY?.trim() || env.CLAWROUTERS_API_KEY?.trim()
  );
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
    proc.on("error", (err) => { out += `\n[spawn error] ${err}\n`; resolve({ code: 127, output: out }); });
    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

// ── 写配置（幂等）────────────────────────────────────────────────────────────

function ensureConfig() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });

  if (!hasApiKeys()) {
    console.log("[sidecar] no API keys — skipping config generation");
    return;
  }

  if (isConfigured()) {
    console.log("[sidecar] already configured — patching token + channels");
    patchConfig(CONFIG_PATH, (cfg) => {
      setIn(cfg, "gateway.auth.token", GATEWAY_TOKEN);
      setIn(cfg, "gateway.port", GATEWAY_PORT);
      setIn(cfg, "gateway.bind", "loopback");
      setIn(cfg, "gateway.trustedProxies", ["127.0.0.1", "::1"]);
      setIn(cfg, "gateway.controlUi.allowInsecureAuth", true);
      setIn(cfg, "gateway.controlUi.dangerouslyDisableDeviceAuth", true);
      setIn(cfg, "gateway.controlUi.basePath", "/openclaw");
      setIn(cfg, "gateway.controlUi.allowedOrigins", [
        `http://localhost:${PORT}`,
        `http://127.0.0.1:${PORT}`,
        "https://oneclaw.net",
        "https://www.oneclaw.net",
      ]);
      const loadPaths = resolvePreinstalledPluginPaths();
      if (loadPaths.length > 0) setIn(cfg, "plugins.load.paths", loadPaths);
    });
    reconcileAllChannels({ env: process.env, stateDir: STATE_DIR });
    return;
  }

  console.log("[sidecar] generating openclaw.json...");
  generateConfigDirect({
    configPath: CONFIG_PATH,
    workspaceDir: WORKSPACE_DIR,
    gatewayToken: GATEWAY_TOKEN,
    port: GATEWAY_PORT,
    publicPort: PORT,
    env: process.env,
  });
  console.log("[sidecar] openclaw.json ready");
}

// ── 初始化 workspace 文件（SOUL.md、AGENTS.md、IDENTITY.md 等）─────────────
// generateConfigDirect 跳过了 `openclaw onboard`，因此 workspace 引导文件
// 也不会自动创建。openclaw setup 可以在不运行完整 onboard 的情况下填充缺失的
// 引导文件（幂等：已有文件不会被覆盖）。
async function ensureWorkspaceFiles() {
  if (!isConfigured()) return;
  const soul = path.join(WORKSPACE_DIR, "SOUL.md");
  const agents = path.join(WORKSPACE_DIR, "AGENTS.md");
  // 只要 SOUL.md 存在就认为 workspace 已初始化，跳过 setup CLI 调用
  if (fs.existsSync(soul) && fs.existsSync(agents)) return;
  console.log("[sidecar] running openclaw setup to populate workspace files...");
  const result = await runCmd(OPENCLAW_NODE, clawArgs(["setup", "--workspace", WORKSPACE_DIR]));
  console.log(`[sidecar] setup exit=${result.code}`);
  if (result.output) console.log(result.output);
}

// ── Gateway manager ───────────────────────────────────────────────────────────

ensureConfig();

const gateway = createGatewayManager({
  OPENCLAW_NODE,
  clawArgs,
  stateDir: STATE_DIR,
  workspaceDir: WORKSPACE_DIR,
  internalGatewayPort: GATEWAY_PORT,
  internalGatewayHost: GATEWAY_HOST,
  gatewayToken: GATEWAY_TOKEN,
  isConfigured,
});

// ── OneClaw 心跳上报 ──────────────────────────────────────────────────────────
// 通过 /agent/heartbeat 把 gateway 状态、平台连通性上报给 OneClaw 平台。
// sidecar 是心跳发出方，openclaw gateway 是被观测对象（通过 isGatewayReady）。

const oneclaw = createOneclawIntegration({
  apiUrl: ONECLAW_API_URL,
  instanceId: ONECLAW_INSTANCE_ID,
  instanceSecret: ONECLAW_INSTANCE_SECRET,
  workspaceDir: WORKSPACE_DIR,
  gatewayTarget: `http://${GATEWAY_HOST}:${GATEWAY_PORT}`,
  gatewayToken: GATEWAY_TOKEN,
  isGatewayReady: gateway.isGatewayReady,
  isGatewayStarting: gateway.isGatewayStarting,
});

// ── Repair AI key ─────────────────────────────────────────────────────────────

let repairAiKey = readEnvProviderKey(process.env) || readDefaultProviderKey(CONFIG_PATH);

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

// ── Basic Auth 中间件 ─────────────────────────────────────────────────────────
// 所有非健康检查的公开端点都需要 SETUP_PASSWORD。
// 部署到 Railway 后，任何人知道域名就能访问 openclaw WebUI，
// 加 Basic Auth 防止未授权访问。
const requireSetupAuth = createRequireSetupAuth(SETUP_PASSWORD);

function requireBasicAuth(req, res, next) {
  if (!SETUP_PASSWORD) return next(); // 未设密码则放行（本地开发）
  return requireSetupAuth(req, res, next);
}

// ── 路由 ──────────────────────────────────────────────────────────────────────

// 健康检查（无需认证）——即使 openclaw 挂了也返回 200
app.get("/health", (_req, res) => res.json({ ok: true, gatewayReady: gateway.isGatewayReady() }));
app.get("/healthz", (_req, res) => res.json({ ok: true, gatewayReady: gateway.isGatewayReady() }));

// ── setup 配置页面 ─────────────────────────────────────────────────────────────
// 密码保护（SETUP_PASSWORD），用于首次配置 API key + 渠道

async function handleSetupConfigure(req, res) {
  // 用户提交的配置
  const { apiKey, provider, channels: ch = {} } = req.body || {};

  // 构建 env 对象用于 generateConfigDirect
  const setupEnv = { ...process.env };
  if (provider === "clawrouters") setupEnv.CLAWROUTERS_API_KEY = apiKey;
  else if (provider === "anthropic") setupEnv.ANTHROPIC_API_KEY = apiKey;
  else if (provider === "openai") setupEnv.OPENAI_API_KEY = apiKey;
  else if (provider === "gemini") setupEnv.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;
  else if (provider === "openrouter") setupEnv.OPENROUTER_API_KEY = apiKey;
  else if (provider === "deepseek") setupEnv.DEEPSEEK_API_KEY = apiKey;

  if (ch.telegram?.botToken) setupEnv.TELEGRAM_BOT_TOKEN = ch.telegram.botToken;
  if (ch.discord?.botToken) setupEnv.DISCORD_BOT_TOKEN = ch.discord.botToken;
  if (ch.slack?.botToken && ch.slack?.appToken) {
    setupEnv.SLACK_BOT_TOKEN = ch.slack.botToken;
    setupEnv.SLACK_APP_TOKEN = ch.slack.appToken;
  }
  if (ch.feishu?.appId && ch.feishu?.appSecret) {
    setupEnv.FEISHU_APP_ID = ch.feishu.appId;
    setupEnv.FEISHU_APP_SECRET = ch.feishu.appSecret;
  }
  if (ch.whatsapp?.enabled) setupEnv.WHATSAPP_ENABLED = "1";
  if (ch.wechat?.enabled) setupEnv.WECHAT_ENABLED = "1";

  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });

    generateConfigDirect({
      configPath: CONFIG_PATH,
      workspaceDir: WORKSPACE_DIR,
      gatewayToken: GATEWAY_TOKEN,
      port: GATEWAY_PORT,
      publicPort: PORT,
      env: setupEnv,
    });

    // 初始化 workspace 文件（SOUL.md、AGENTS.md 等）
    const result = await runCmd(OPENCLAW_NODE, clawArgs(["setup", "--workspace", WORKSPACE_DIR]));
    console.log(`[setup] openclaw setup exit=${result.code}`);

    // 刷新 repair AI key（新配置可能换了 provider）
    repairAiKey = readEnvProviderKey(setupEnv) || readDefaultProviderKey(CONFIG_PATH);

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

app.get("/setup", requireBasicAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});
app.post("/setup/api/configure", requireBasicAuth, handleSetupConfigure);

// ── 修复助手 API ──────────────────────────────────────────────────────────────
const repairRouter = createRepairRouter({
  requireSetupAuth,
  instanceSecret: process.env.ONECLAW_INSTANCE_SECRET,
  runCmd,
  clawArgs,
  OPENCLAW_NODE,
  restartGateway: gateway.restartGateway,
  configFilePath: () => CONFIG_PATH,
  gatewayManager: gateway,
  getRepairAiKey: () => repairAiKey,
});
app.use("/repair", requireBasicAuth);
app.use("/repair", repairRouter);

// ── WebUI 入口 ────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  if (!isConfigured()) return res.redirect("/setup");
  res.redirect("/openclaw");
});

// ── 反向代理到 openclaw gateway ───────────────────────────────────────────────
// 所有 /openclaw* 路径需要 Basic Auth + 自动注入 ?token=
// final catch-all 先把 /openclaw 请求重定向补上 token，再 proxy 到 gateway
const proxy = httpProxy.createProxyServer({
  target: `http://${GATEWAY_HOST}:${GATEWAY_PORT}`,
  ws: true,
  xfwd: true,
  changeOrigin: true,
});
proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err.message);
  if (res && !res.headersSent) {
    res.writeHead(502).end("gateway unavailable");
  }
});

app.use((req, res) => {
  // /openclaw 路径需要 Basic Auth + token 注入
  if (req.path.startsWith("/openclaw")) {
    return requireBasicAuth(req, res, () => {
      if (!req.query.token) {
        return res.redirect(`/openclaw?token=${GATEWAY_TOKEN}`);
      }
      if (gateway.isGatewayStarting() && !gateway.isGatewayReady()) {
        return res.sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
      }
      proxy.web(req, res);
    });
  }
  proxy.web(req, res);
});

// ── 启动 ──────────────────────────────────────────────────────────────────────

const server = app.listen(PORT, () => {
  console.log(`[sidecar] listening on port ${PORT}`);
  console.log(`[sidecar] repair API: http://localhost:${PORT}/repair`);
  console.log(`[sidecar] oneclaw heartbeat: ${ONECLAW_INSTANCE_ID ? "enabled" : "disabled"}`);

  // 先启动心跳（心跳内部会等 gateway ready 才上报 healthy）
  if (ONECLAW_INSTANCE_ID) {
    oneclaw.start();
  }

  if (isConfigured()) {
    gateway.ensureGatewayRunning()
      .then(async () => {
        console.log("[sidecar] gateway ready");
        await ensureWorkspaceFiles();
        if (ONECLAW_TEMPLATE_ID) await oneclaw.applyTemplateFromEnv(ONECLAW_TEMPLATE_ID);
      })
      .catch((err) => console.error(`[sidecar] gateway failed to start: ${err.message}`));
  } else {
    console.log("[sidecar] no config — gateway will not start until configured");
  }
});

// WebSocket 升级转发到 openclaw
server.on("upgrade", (req, socket, head) => {
  // WebSocket 连接也要过 Basic Auth + 确保有 token
  if (req.url?.startsWith("/openclaw")) {
    const { searchParams } = new URL(req.url, "http://x");
    if (!searchParams.get("token")) {
      // 修改 URL 追加 token
      const q = req.url.includes("?") ? "&" : "?";
      req.url = `${req.url}${q}token=${GATEWAY_TOKEN}`;
    }
  }
  proxy.ws(req, socket, head);
});

// ── 优雅退出 ──────────────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[sidecar] ${signal} received — shutting down`);
  oneclaw.stop();
  gateway.stopGateway();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
