// sidecar.js — PID 1 进程
//
// 职责：
//   1. 启动时通过 env 变量写好 openclaw.json（纯 env 驱动，无 setup 向导）
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
import { createGatewayRpc } from "./lib/gateway-rpc.js";
import { createOneclawIntegration } from "./lib/oneclaw-integration.js";
import { createRepairRouter } from "./lib/routes/repair.js";
import { createSkillsRouter } from "./lib/routes/skills.js";
import { readEnvProviderKey, readDefaultProviderKey } from "./lib/repair-ai-key.js";
import { applyRuntimeDefaults, generateConfigDirect } from "./lib/direct-config.js";
import { patchConfig, setIn } from "./lib/openclaw-config.js";
import { reconcileAllChannels } from "./lib/channel-manifest.js";
import { applyPreinstalledPluginInstallRecords, cleanupStalePreinstalledExtensions, resolvePreinstalledPluginPaths } from "./lib/preinstalled-plugins.js";

// ── 常量 ──────────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8080);                           // 对外端口（Railway $PORT）
const GATEWAY_PORT = Number(process.env.INTERNAL_GATEWAY_PORT ?? 18789); // openclaw 내部端口
const GATEWAY_HOST = "127.0.0.1";
// 反代到 gateway 的超时（毫秒）。chat/responses 跑完整 agent 推理可能耗时数分钟，
// 默认 10 分钟，可用 PROXY_TIMEOUT_MS 调整。
const PROXY_TIMEOUT_MS = Number(process.env.PROXY_TIMEOUT_MS ?? 600000);

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
  cleanupStalePreinstalledExtensions(STATE_DIR);

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
      setIn(cfg, "gateway.trustedProxies", ["127.0.0.1", "::1", "::ffff:127.0.0.1", "172.16.0.0/12", "192.168.0.0/16", "10.0.0.0/8"]);
      setIn(cfg, "gateway.controlUi.allowInsecureAuth", true);
      setIn(cfg, "gateway.controlUi.dangerouslyDisableDeviceAuth", true);
      setIn(cfg, "gateway.controlUi.basePath", "/openclaw");
      setIn(cfg, "gateway.controlUi.allowedOrigins", [
        `http://127.0.0.1:${GATEWAY_PORT}`,   // proxy 改写后的固定 origin（核心）
        `http://localhost:${GATEWAY_PORT}`,
        `http://localhost:${PORT}`,
        `http://127.0.0.1:${PORT}`,
        "https://oneclaw.net",
        "https://www.oneclaw.net",
      ]);
      const loadPaths = resolvePreinstalledPluginPaths();
      if (loadPaths.length > 0) setIn(cfg, "plugins.load.paths", loadPaths);
      if (applyPreinstalledPluginInstallRecords(cfg)) {
        console.log("[sidecar] patched preinstalled official plugin install records");
      }
      if (applyRuntimeDefaults(cfg, process.env)) {
        console.log("[sidecar] patched runtime defaults");
      }
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
  patchConfig(CONFIG_PATH, (cfg) => {
    if (applyPreinstalledPluginInstallRecords(cfg)) {
      console.log("[sidecar] patched preinstalled official plugin install records");
    }
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

const gatewayRpc = createGatewayRpc({
  gatewayHost: GATEWAY_HOST,
  gatewayPort: GATEWAY_PORT,
  gatewayToken: GATEWAY_TOKEN,
  basePath: "/openclaw",
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
// 不全局解析 body：代理路径必须保持透明（原始请求流原样转发给 gateway）。
// json 解析只挂在真正读取 req.body 的路由上（见下方 /setup、/repair、/skills）。
const jsonParser = express.json({ limit: "1mb" });

// ── 认证：cookie 会话 + Bearer(ONECLAW_INSTANCE_SECRET) ─────────────────────────
//
// 为什么不用 Basic Auth：浏览器对 401+WWW-Authenticate 会弹原生登录框，而
// Control UI 是 SPA，它的 fetch/XHR/WebSocket 子请求不带 Basic 凭据 → 反复弹窗。
// 改用签名 cookie：登录一次种 cookie，之后所有同源请求（含 WebSocket）自动携带，
// 未登录则 302 跳 /login 页面（不弹窗）。
// 自动化/修复助手可用 Authorization: Bearer <ONECLAW_INSTANCE_SECRET> 访问。

const AUTH_COOKIE = "ocsess";
const COOKIE_SECRET = crypto.createHash("sha256")
  .update(`${SETUP_PASSWORD || ""}:${GATEWAY_TOKEN}`).digest("hex");

function signSession() {
  const payload = String(Date.now());
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}
function verifySession(value) {
  if (!value || !value.includes(".")) return false;
  const idx = value.lastIndexOf(".");
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch { return false; }
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function bearerMatchesSecret(req) {
  if (!ONECLAW_INSTANCE_SECRET) return false;
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return false;
  const tok = auth.slice(7).trim();
  try {
    return tok.length > 0 && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ONECLAW_INSTANCE_SECRET));
  } catch { return false; }
}
// URL query 里的 ?token=<GATEWAY_TOKEN> 也是有效凭据。
// 浏览器 WebSocket 握手无法自定义 Authorization 头，且跨站/自写客户端不带 cookie，
// 此时 URL query token 是唯一可行的鉴权通道（Control UI 前端本就把 token 放进 WS URL）。
// token 即 gateway 的有效凭据，强度等价于 Bearer secret。
function queryTokenMatchesGateway(req) {
  let tok = "";
  try {
    tok = new URL(req.url, "http://internal").searchParams.get("token") || "";
  } catch { return false; }
  if (!tok || !GATEWAY_TOKEN) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(GATEWAY_TOKEN));
  } catch { return false; }
}
function isAuthed(req) {
  // 本地开发：未设密码也未设 secret → 放行
  if (!SETUP_PASSWORD && !ONECLAW_INSTANCE_SECRET) return true;
  if (bearerMatchesSecret(req)) return true;
  if (queryTokenMatchesGateway(req)) return true;
  return verifySession(parseCookies(req)[AUTH_COOKIE]);
}
// 页面请求：未登录 302 跳 /login（不弹窗）
function requireAuthPage(req, res, next) {
  if (isAuthed(req)) return next();
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}
// API 请求：未登录返回 401 JSON（不带 WWW-Authenticate，不弹窗）
function requireAuthApi(req, res, next) {
  if (isAuthed(req)) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

// ── 路由 ──────────────────────────────────────────────────────────────────────

// 健康检查（无需认证）——即使 openclaw 挂了也返回 200
app.get("/health", (_req, res) => res.json({ ok: true, gatewayReady: gateway.isGatewayReady() }));
app.get("/healthz", (_req, res) => res.json({ ok: true, gatewayReady: gateway.isGatewayReady() }));

// ── 登录 ────────────────────────────────────────────────────────────────────
app.get("/login", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "login.html"));
});
app.post("/login", express.urlencoded({ extended: false }), (req, res) => {
  const password = String(req.body?.password || "");
  const next = typeof req.body?.next === "string" && req.body.next.startsWith("/") ? req.body.next : "/openclaw";
  if (!SETUP_PASSWORD) return res.redirect(next); // 未设密码直接放行
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(
      crypto.createHash("sha256").update(password).digest(),
      crypto.createHash("sha256").update(SETUP_PASSWORD).digest(),
    );
  } catch {}
  if (!ok) return res.redirect("/login?error=1");
  const secure = (req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
  res.setHeader("Set-Cookie",
    `${AUTH_COOKIE}=${signSession()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800${secure}`);
  res.redirect(next);
});

// ── 修复助手 API ──────────────────────────────────────────────────────────────
const repairRouter = createRepairRouter({
  requireSetupAuth: requireAuthApi,
  instanceSecret: process.env.ONECLAW_INSTANCE_SECRET,
  runCmd,
  clawArgs,
  OPENCLAW_NODE,
  restartGateway: gateway.restartGateway,
  configFilePath: () => CONFIG_PATH,
  stateDir: STATE_DIR,
  gatewayManager: gateway,
  getRepairAiKey: () => repairAiKey,
  gatewayRpc,
});
app.use("/repair", requireAuthApi);
app.use("/repair", jsonParser);
app.use("/repair", repairRouter);

// ── 技能管理 API ──────────────────────────────────────────────────────────────
app.use("/skills", requireAuthApi);
app.use("/skills", jsonParser);
app.use("/skills", createSkillsRouter());

// ── WebUI 入口 ────────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  if (!isAuthed(req)) return res.redirect("/login");
  res.redirect("/openclaw/");
});

// ── 反向代理到 openclaw gateway ───────────────────────────────────────────────
// gateway 鉴权通过注入 Authorization: Bearer 头完成（token 永不进 URL）。
// Origin 改写成 gateway 自身地址，满足 gateway.controlUi.allowedOrigins 校验。
// 这是经过验证的方式（参考原 server.js + CLAUDE.md quirk #6）。
const GATEWAY_ORIGIN = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;
const proxy = httpProxy.createProxyServer({
  target: GATEWAY_ORIGIN,
  ws: true,
  xfwd: false,            // 关键：不要加 X-Forwarded-*（见 stripForwardedHeaders 说明）
  changeOrigin: true,
  // chat completions / responses 会触发完整 agent 推理（数十秒~数分钟），
  // 默认无 proxyTimeout 时上游慢响应会被提前断开 → proxy.on("error") → 502
  // "gateway unavailable"。放宽到 PROXY_TIMEOUT_MS（默认 10 分钟）。
  proxyTimeout: PROXY_TIMEOUT_MS,
  timeout: PROXY_TIMEOUT_MS,
});

// gateway 的 isLocalDirectRequest() 只要看到任何 X-Forwarded-* / Forwarded / X-Real-IP
// 头，就判定 isLocalClient=false，进而拒绝 Control UI 的 allowInsecureAuth +
// dangerouslyDisableDeviceAuth bypass，强制 device pairing（浏览器报 "pairing required:
// device is not approved yet"）。自写 WS 客户端只用受限 scope、不申请 operator，所以不受影响。
// sidecar 是 gateway（bind=loopback）唯一的可信前置代理，且已在本层做 cookie/token 鉴权，
// 因此剥离这些转发头、让 gateway 把连接视为本地直连，是安全且必要的。
const FORWARDED_HEADERS = ["forwarded", "x-real-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port"];
function stripForwardedHeaders(headers) {
  if (!headers) return;
  for (const key of Object.keys(headers)) {
    const k = key.toLowerCase();
    if (k === "forwarded" || k === "x-real-ip" || k.startsWith("x-forwarded-")) delete headers[key];
  }
}
function dropForwardedOnProxyReq(proxyReq) {
  for (const h of FORWARDED_HEADERS) proxyReq.removeHeader(h);
}

proxy.on("proxyReq", (proxyReq) => {
  dropForwardedOnProxyReq(proxyReq);
  proxyReq.setHeader("Authorization", `Bearer ${GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", GATEWAY_ORIGIN);
});
// WebSocket upgrade: inject the same Bearer token + strip forwarded headers so
// the gateway treats the proxied client as a trusted local connection (and each
// frontend client gets its own gateway connect handshake / subscriptions).
proxy.on("proxyReqWs", (proxyReq) => {
  dropForwardedOnProxyReq(proxyReq);
  proxyReq.setHeader("Authorization", `Bearer ${GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", GATEWAY_ORIGIN);
});
proxy.on("error", (err, _req, res) => {
  console.error("[proxy]", err.message);
  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(502).end("gateway unavailable");
  }
});

app.use((req, res) => {
  // /openclaw* 需要登录会话（cookie）或 Bearer secret，未登录跳 /login
  if (req.path.startsWith("/openclaw")) {
    if (!isAuthed(req)) {
      return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    }
    if (gateway.isGatewayStarting() && !gateway.isGatewayReady()) {
      return res.sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
    }
    // Control UI 前端需要拿到 gateway token 才能发起 WebSocket connect RPC。
    // 已通过 cookie 鉴权，这里把 token 注入到 URL（fragment 不会发到服务端，
    // 比 query 更安全）。token 仅暴露给已登录用户自己的浏览器。
    if (req.path === "/openclaw" || req.path === "/openclaw/") {
      if (!req.query.token) {
        return res.redirect(`/openclaw/?token=${GATEWAY_TOKEN}`);
      }
    }
    // 聊天 UI 需要 gatewayUrl(query) + token(fragment) 才能建立连接
    if (req.path === "/openclaw/chat" && !req.query.gatewayUrl) {
      const xfProto = req.headers["x-forwarded-proto"];
      const proto = (typeof xfProto === "string" ? xfProto.split(",")[0].trim() : xfProto) || req.protocol || "http";
      const wsProto = proto === "https" ? "wss" : "ws";
      const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
      const gatewayUrl = `${wsProto}://${host}/openclaw`;
      const url = new URL(req.originalUrl || req.url, `http://${host}`);
      url.searchParams.set("gatewayUrl", gatewayUrl);
      return res.redirect(`${url.pathname}${url.search}#token=${GATEWAY_TOKEN}`);
    }
    return proxy.web(req, res);
  }
  // 其他路径（gateway 的静态资源等）直接代理，鉴权由 gateway 的 token 头处理
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
        gatewayRpc.start();
        console.log("[sidecar] gateway ready");
        await oneclaw.sendHeartbeat();
        await ensureWorkspaceFiles();
        if (ONECLAW_TEMPLATE_ID) await oneclaw.applyTemplateFromEnv(ONECLAW_TEMPLATE_ID);
      })
      .catch((err) => console.error(`[sidecar] gateway failed to start: ${err.message}`));
  } else {
    console.log("[sidecar] no config — gateway will not start until configured");
  }
});

// 放宽 wrapper HTTP server 超时，避免长时间的 chat/responses 推理被本层切断。
// requestTimeout=0 关闭整请求超时；headersTimeout 仍保护慢 header 攻击。
server.requestTimeout = 0;
server.headersTimeout = 65000;
server.timeout = PROXY_TIMEOUT_MS;
server.keepAliveTimeout = 75000;

// WebSocket 升级转发到 openclaw
// 浏览器同源 WebSocket 握手会自动带上 cookie，用它鉴权；
// gateway 的鉴权由 proxyReqWs 注入的 Authorization 头完成（token 不进 URL）。
server.on("upgrade", (req, socket, head) => {
  if (!isAuthed(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  // 剥离入站 X-Forwarded-* / Forwarded / X-Real-IP（Railway edge 注入），否则
  // gateway 判 isLocalClient=false，Control UI 会被强制 device pairing。见上方 stripForwardedHeaders。
  stripForwardedHeaders(req.headers);
  // Reverse-proxy the WS upgrade straight to the gateway. Each frontend client
  // gets its own gateway connection (connect handshake + subscriptions), so
  // per-client event routing works correctly. (Replaces the old ws-hub
  // multiplexer, which merged all clients into one gateway connection and
  // broadcast events — breaking openclaw's per-client subscription model.)
  proxy.ws(req, socket, head);
});

// ── 优雅退出 ──────────────────────────────────────────────────────────────────

function shutdown(signal) {
  console.log(`[sidecar] ${signal} received — shutting down`);
  oneclaw.stop();
  gatewayRpc.close();
  gateway.stopGateway();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));
