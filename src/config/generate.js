// Unified openclaw.json config generator — zero-subprocess alternative to
// `openclaw onboard`.
//
// 完全在进程内生成配置，不调用任何 CLI 子进程（原 onboard 耗时 30-60s）。
// 配置结构遵循官方文档最佳实践：docs.openclaw.ai
//
// Also re-exports the shared helpers from runtime-defaults.js so callers
// that previously imported from direct-config.js or auto-config.js can
// switch to this single entry point.

import fs from "node:fs";
import path from "node:path";
import { resolvePreinstalledPluginPaths } from "./plugins.js";
import {
  resolveClawroutersApiBaseUrl,
  buildClawroutersMemorySearch,
  applyRuntimeDefaults,
} from "./runtime-defaults.js";

// Re-export the runtime-defaults public API so the combined public surface
// of this module is unchanged relative to the old direct-config.js.
export { resolveClawroutersApiBaseUrl, buildClawroutersMemorySearch, applyRuntimeDefaults };

function truthy(v) {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const CLAWROUTERS_API_KEY_REF = { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" };
const DEFAULT_HEARTBEAT = { every: "2h", target: "last" };

export function patchClawroutersProviderBaseUrl(cfg, env = process.env) {
  return applyRuntimeDefaults(cfg, env);
}

// ── HTTP /v1/* 端点开关（env 注入，默认全关）──────────────────────────────────
// 返回 gateway.http.endpoints 对象；两个开关都没开则返回 null（不写 http 字段）。
export function buildHttpEndpoints(env = process.env) {
  const endpoints = {};
  if (truthy(env.GATEWAY_CHAT_COMPLETIONS_ENABLED)) {
    endpoints.chatCompletions = { enabled: true };
  }
  if (truthy(env.GATEWAY_RESPONSES_ENABLED)) {
    endpoints.responses = { enabled: true };
  }
  return Object.keys(endpoints).length > 0 ? endpoints : null;
}

// ── 各 provider 配置构建函数 ──────────────────────────────────────────────────
// 仅包含 provider 发现和 API 路由所需的最小字段。
// 模型列表不在此硬编码——clawrouters 插件加载后会自动注册可用模型；
// 其他 provider 的模型由 openclaw 从 API 端点动态拉取（models.mode = "merge"）。

function providerClawrouters(env = process.env) {
  return {
    baseUrl: resolveClawroutersApiBaseUrl(env),
    // SecretRef：key 从运行时环境变量读，不明文写入配置文件
    apiKey: CLAWROUTERS_API_KEY_REF,
    api: "openai-completions",
    // 仅声明 auto 入口点——插件激活后会补充完整模型列表
    models: [
      { id: "auto", name: "auto", input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  };
}

function providerAnthropic() {
  return {
    api: "anthropic-messages",
    apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
  };
}

function providerOpenai() {
  return {
    api: "openai-completions",
    apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
  };
}

function providerGemini() {
  return {
    api: "google-gemini",
    apiKey: { source: "env", provider: "default", id: "GOOGLE_GENERATIVE_AI_API_KEY" },
  };
}

function providerOpenrouter() {
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    apiKey: { source: "env", provider: "default", id: "OPENROUTER_API_KEY" },
  };
}

function providerDeepseek() {
  return {
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    apiKey: { source: "env", provider: "default", id: "DEEPSEEK_API_KEY" },
  };
}

// ── 从环境变量推断主 provider ─────────────────────────────────────────────────
// 优先级：clawrouters > anthropic > openai > gemini > openrouter > deepseek
function resolveProvider(env) {
  if ((env.CLAWROUTERS_KEY || env.CLAWROUTERS_API_KEY)?.trim())
    return { id: "clawrouters", primaryModel: "clawrouters/auto", build: () => providerClawrouters(env) };
  if (env.ANTHROPIC_API_KEY?.trim())
    return { id: "anthropic", primaryModel: "anthropic/claude-sonnet-4-6", build: providerAnthropic };
  if (env.OPENAI_API_KEY?.trim())
    return { id: "openai", primaryModel: "openai/gpt-4o", build: providerOpenai };
  if (env.GOOGLE_GENERATIVE_AI_API_KEY?.trim())
    return { id: "google", primaryModel: "google/gemini-2.5-pro", build: providerGemini };
  if (env.OPENROUTER_API_KEY?.trim())
    return { id: "openrouter", primaryModel: "openrouter/anthropic/claude-sonnet-4-6", build: providerOpenrouter };
  if (env.DEEPSEEK_API_KEY?.trim())
    return { id: "deepseek", primaryModel: "deepseek/deepseek-chat", build: providerDeepseek };
  return null;
}

/**
 * 在进程内生成完整的 openclaw.json，不调用任何 CLI 子进程。
 *
 * @param {object} opts
 * @param {string} opts.configPath   - openclaw.json 写入路径
 * @param {string} opts.workspaceDir - agent workspace 目录
 * @param {string} opts.gatewayToken - gateway bearer token
 * @param {number} opts.port         - gateway 监听端口（sidecar 内部端口，默认 18789）
 * @param {number} opts.publicPort   - sidecar 对外端口（用于 allowedOrigins，默认 8080）
 * @param {object} opts.env          - 环境变量（默认 process.env）
 */
export function generateConfigDirect(opts) {
  const {
    configPath,
    workspaceDir,
    gatewayToken,
    port = 18789,
    publicPort = 8080,
    env = process.env,
  } = opts;

  const provider = resolveProvider(env);
  const isClawrouters = provider?.id === "clawrouters";

  // ── Gateway ───────────────────────────────────────────────────
  // bind=loopback：sidecar 做反代，gateway 只在内部监听
  // trustedProxies：信任 sidecar 转发，含 Docker 网桥网段
  // allowedOrigins：sidecar 会把浏览器的 Origin 改写成 gateway 自身地址
  //   (http://127.0.0.1:<port>)，所以这里只需白名单这个固定地址即可——
  //   无论 Railway 公网域名是什么都不用改（域名各不相同也能用）。
  const gatewayOrigin = `http://127.0.0.1:${port}`;
  const gateway = {
    mode: "local",
    auth: { mode: "token", token: gatewayToken },
    port,
    bind: "loopback",
    trustedProxies: ["127.0.0.1", "::1", "::ffff:127.0.0.1", "172.16.0.0/12", "192.168.0.0/16", "10.0.0.0/8"],
    controlUi: {
      allowInsecureAuth: true,
      dangerouslyDisableDeviceAuth: true,
      basePath: "/openclaw",
      allowedOrigins: [
        gatewayOrigin,                  // proxy 改写后的固定 origin（核心）
        `http://localhost:${port}`,
        `http://localhost:${publicPort}`,
        `http://127.0.0.1:${publicPort}`,
        "https://oneclaw.net",
        "https://www.oneclaw.net",
      ],
    },
  };

  // ── HTTP /v1/* OpenAI 兼容端点 ─────────────────────────────────
  // 默认全关（openclaw 源码 server-http.ts）。chatCompletions / responses
  // 各自独立开关；/v1/models 与 /v1/embeddings 无独立开关，只要这两者任一
  // 打开就跟着开放。通过 env 注入：
  //   GATEWAY_CHAT_COMPLETIONS_ENABLED=true → POST /v1/chat/completions
  //   GATEWAY_RESPONSES_ENABLED=true        → POST /v1/responses
  // 仍受 gateway.auth 鉴权（外部客户端需带 Bearer token）。
  const httpEndpoints = buildHttpEndpoints(env);
  if (httpEndpoints) gateway.http = { endpoints: httpEndpoints };

  // ── Models ────────────────────────────────────────────────────
  // models.mode=merge：插件/provider 的模型列表与此配置合并，不覆盖
  const models = { mode: "merge", providers: {} };
  if (provider) {
    models.providers[provider.id] = provider.build();
  }

  // ── Agents ────────────────────────────────────────────────────
  const agentDefaults = {
    workspace: workspaceDir,
    model: { primary: env.DEFAULT_MODEL?.trim() || provider?.primaryModel || "" },
    // heartbeat：2 小时发一次，保持连接活跃（官方文档 agents.defaults.heartbeat）
    heartbeat: DEFAULT_HEARTBEAT,
    // 上下文压缩：session 较长时自动压缩早期历史，减少 token 消耗
    // （官方 /compact 功能的自动触发阈值）
    bootstrapMaxChars: 20000,
    bootstrapTotalMaxChars: 60000,
  };

  // clawrouters 额外配置：图像/视频生成模型
  if (isClawrouters) {
    // clawrouters 插件激活后自动注册 clawrouters-image / clawrouters-video provider
    agentDefaults.imageGenerationModel = { primary: "clawrouters-image/auto" };
    agentDefaults.videoGenerationModel = { primary: "clawrouters-video/auto", timeoutMs: 600000 };
    agentDefaults.mediaGenerationAutoProviderFallback = false;
    agentDefaults.memorySearch = buildClawroutersMemorySearch(env);
  }

  // ── Plugins ───────────────────────────────────────────────────
  const plugins = { entries: {} };

  // 预装插件路径（镜像里 /opt/openclaw-plugins，不在 volume 内）
  const loadPaths = resolvePreinstalledPluginPaths(env);
  if (loadPaths.length > 0) plugins.load = { paths: loadPaths };

  if (isClawrouters) plugins.entries.clawrouters = { enabled: true };
  if (truthy(env.WECHAT_ENABLED) || truthy(env.WEIXIN_ENABLED)) {
    plugins.entries["openclaw-weixin"] = { enabled: true };
  }

  // ── Channels ──────────────────────────────────────────────────
  const DM_OPEN  = "open";
  const ALLOW_ALL = ["*"];
  const channels = {};
  const bindings = [];

  if (env.TELEGRAM_BOT_TOKEN?.trim()) {
    channels.telegram = {
      enabled: true,
      accounts: { main: { enabled: true, botToken: env.TELEGRAM_BOT_TOKEN.trim(), dmPolicy: DM_OPEN, allowFrom: ALLOW_ALL, groupPolicy: "allowlist" } },
    };
    bindings.push({ agentId: "main", match: { channel: "telegram", accountId: "main" } });
  }
  if (env.DISCORD_BOT_TOKEN?.trim()) {
    channels.discord = {
      enabled: true,
      accounts: { main: { enabled: true, token: env.DISCORD_BOT_TOKEN.trim(), dm: { policy: DM_OPEN, allowFrom: ALLOW_ALL }, groupPolicy: "allowlist" } },
    };
    bindings.push({ agentId: "main", match: { channel: "discord", accountId: "main" } });
    plugins.entries.discord = { enabled: true };
  }
  if (env.SLACK_BOT_TOKEN?.trim() && env.SLACK_APP_TOKEN?.trim()) {
    channels.slack = {
      enabled: true,
      accounts: { main: { enabled: true, botToken: env.SLACK_BOT_TOKEN.trim(), appToken: env.SLACK_APP_TOKEN.trim() } },
    };
    bindings.push({ agentId: "main", match: { channel: "slack", accountId: "main" } });
    plugins.entries.slack = { enabled: true };
  }
  if (env.FEISHU_APP_ID?.trim() && env.FEISHU_APP_SECRET?.trim()) {
    channels.feishu = {
      enabled: true,
      accounts: { main: { enabled: true, appId: env.FEISHU_APP_ID.trim(), appSecret: env.FEISHU_APP_SECRET.trim(), dmPolicy: DM_OPEN, allowFrom: ALLOW_ALL } },
    };
    bindings.push({ agentId: "main", match: { channel: "feishu", accountId: "main" } });
    plugins.entries.feishu = { enabled: true };
  }
  if (truthy(env.WHATSAPP_ENABLED)) {
    channels.whatsapp = {
      enabled: true,
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "disabled",
      groupAllowFrom: [],
      groups: {},
    };
    plugins.entries.whatsapp = { enabled: true };
  }
  if (truthy(env.WECHAT_ENABLED) || truthy(env.WEIXIN_ENABLED)) {
    channels["openclaw-weixin"] = {
      enabled: true,
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "disabled",
      groupAllowFrom: [],
      groups: {},
    };
  }

  // ── Session ───────────────────────────────────────────────────
  // per-channel-peer：每个渠道的每个用户独立 session，互不干扰
  const session = { dmScope: "per-channel-peer" };

  // ── Tools ─────────────────────────────────────────────────────
  // profile=full：无限制，等同于不设置 profile（参考官方文档）
  const tools = { profile: "full" };

  // ── 组装最终配置 ──────────────────────────────────────────────
  const cfg = { gateway, session, tools, models, agents: { defaults: agentDefaults }, plugins, channels, bindings };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  console.log(`[generate] openclaw.json written (provider=${provider?.id ?? "none"})`);
  return cfg;
}

// ── Auth / onboard helpers (migrated from auto-config.js) ────────────────────
// These were used by the setup-wizard path; kept here so the test suite and
// any future callers have a single config import.

export function hasAutoConfigEnvVars(env = process.env) {
  const keys = [
    env.ANTHROPIC_API_KEY,
    env.OPENAI_API_KEY,
    env.GOOGLE_GENERATIVE_AI_API_KEY,
    env.DEEPSEEK_API_KEY,
    env.OPENROUTER_API_KEY,
    env.CLAWROUTERS_KEY,
    env.CLAWROUTERS_API_KEY,
  ];
  return keys.some((k) => !!k?.trim());
}

export function buildOnboardArgs(payload) {
  const args = [
    "onboard", "--non-interactive", "--accept-risk", "--json",
    "--no-install-daemon", "--skip-health", "--skip-skills", "--skip-channels",
    "--workspace", payload.workspaceDir,
    "--gateway-bind", "loopback",
    "--gateway-port", String(payload.internalGatewayPort),
    "--gateway-auth", "token",
    "--gateway-token", payload.gatewayToken,
    "--flow", payload.flow || "quickstart",
  ];

  if (!payload.authChoice) return args;

  if (payload.authChoice === "custom-api-key") {
    // 走 OpenClaw 原生 custom-api-key 路径，避免 openai-api-key 兜底导致
    // onboard 把 default model 设成 openai/gpt-5.5 -> 强制安装 @openclaw/codex。
    args.push("--auth-choice", "custom-api-key");
    if (payload.customBaseUrl) args.push("--custom-base-url", payload.customBaseUrl);
    const secret = (payload.authSecret || "").trim();
    if (secret) args.push("--custom-api-key", secret);
    args.push("--custom-compatibility", payload.customCompatibility || "openai");
    if (payload.customModelId) args.push("--custom-model-id", payload.customModelId);
    if (payload.customProviderId) args.push("--custom-provider-id", payload.customProviderId);
    args.push(payload.customVision ? "--custom-image-input" : "--custom-text-input");
    return args;
  }

  args.push("--auth-choice", payload.authChoice);
  const secret = (payload.authSecret || "").trim();
  const map = {
    "openai-api-key": "--openai-api-key",
    apiKey: "--anthropic-api-key",
    "openrouter-api-key": "--openrouter-api-key",
    "ai-gateway-api-key": "--ai-gateway-api-key",
    "moonshot-api-key": "--moonshot-api-key",
    "kimi-code-api-key": "--kimi-code-api-key",
    "gemini-api-key": "--gemini-api-key",
    "zai-api-key": "--zai-api-key",
    "minimax-api": "--minimax-api-key",
    "minimax-api-lightning": "--minimax-api-key",
    "synthetic-api-key": "--synthetic-api-key",
    "opencode-zen": "--opencode-zen-api-key",
  };
  const flag = map[payload.authChoice];
  if (flag && secret) args.push(flag, secret);
  if (payload.authChoice === "token" && secret) {
    args.push("--token-provider", "anthropic", "--token", secret);
  }
  return args;
}

export function resolveAuth(env) {
  if (env.ANTHROPIC_API_KEY?.trim())
    return { authChoice: "apiKey", authSecret: env.ANTHROPIC_API_KEY.trim() };
  if (env.OPENAI_API_KEY?.trim())
    return { authChoice: "openai-api-key", authSecret: env.OPENAI_API_KEY.trim() };
  if (env.GOOGLE_GENERATIVE_AI_API_KEY?.trim())
    return { authChoice: "gemini-api-key", authSecret: env.GOOGLE_GENERATIVE_AI_API_KEY.trim() };
  if (env.DEEPSEEK_API_KEY?.trim())
    return { authChoice: "openai-api-key", authSecret: env.DEEPSEEK_API_KEY.trim() };
  if (env.OPENROUTER_API_KEY?.trim())
    return { authChoice: "openrouter-api-key", authSecret: env.OPENROUTER_API_KEY.trim() };
  if ((env.CLAWROUTERS_KEY || env.CLAWROUTERS_API_KEY)?.trim()) {
    return {
      authChoice: "custom-api-key",
      authSecret: (env.CLAWROUTERS_KEY || env.CLAWROUTERS_API_KEY).trim(),
      customBaseUrl: resolveClawroutersApiBaseUrl(env),
      customModelId: "auto",
      customProviderId: "clawrouters",
      customCompatibility: "openai",
      customVision: true,
    };
  }
  return {};
}
