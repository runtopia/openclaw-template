// Direct openclaw.json generator — zero-subprocess alternative to `openclaw onboard`.
//
// 完全在进程内生成配置，不调用任何 CLI 子进程（原 onboard 耗时 30-60s）。
// 配置结构遵循官方文档最佳实践：docs.openclaw.ai

import fs from "node:fs";
import path from "node:path";
import { resolvePreinstalledPluginPaths } from "./preinstalled-plugins.js";

function truthy(v) {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

// ── 各 provider 配置构建函数 ──────────────────────────────────────────────────
// 仅包含 provider 发现和 API 路由所需的最小字段。
// 模型列表不在此硬编码——clawrouters 插件加载后会自动注册可用模型；
// 其他 provider 的模型由 openclaw 从 API 端点动态拉取（models.mode = "merge"）。

function providerClawrouters() {
  return {
    baseUrl: "https://www.clawrouters.com/api/v1",
    // SecretRef：key 从运行时环境变量读，不明文写入配置文件
    apiKey: { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" },
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
    return { id: "clawrouters", primaryModel: "clawrouters/auto", build: providerClawrouters };
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
    heartbeat: { every: "2h", target: "last" },
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

  if (env.TELEGRAM_BOT_TOKEN?.trim()) {
    channels.telegram = {
      enabled: true,
      botToken: env.TELEGRAM_BOT_TOKEN.trim(),
      dmPolicy: DM_OPEN,
      allowFrom: ALLOW_ALL,
      groupPolicy: "allowlist",
    };
  }
  if (env.DISCORD_BOT_TOKEN?.trim()) {
    channels.discord = {
      enabled: true,
      accounts: { default: { token: env.DISCORD_BOT_TOKEN.trim() } },
      dm: { policy: DM_OPEN, allowFrom: ALLOW_ALL },
      groupPolicy: "allowlist",
    };
    plugins.entries.discord = { enabled: true };
  }
  if (env.SLACK_BOT_TOKEN?.trim() && env.SLACK_APP_TOKEN?.trim()) {
    channels.slack = {
      enabled: true,
      botToken: env.SLACK_BOT_TOKEN.trim(),
      appToken: env.SLACK_APP_TOKEN.trim(),
    };
    plugins.entries.slack = { enabled: true };
  }
  if (env.FEISHU_APP_ID?.trim() && env.FEISHU_APP_SECRET?.trim()) {
    channels["openclaw-lark"] = {
      enabled: true,
      appId: env.FEISHU_APP_ID.trim(),
      appSecret: env.FEISHU_APP_SECRET.trim(),
      dmPolicy: DM_OPEN,
      allowFrom: ALLOW_ALL,
    };
    plugins.entries["openclaw-lark"] = { enabled: true };
  }
  if (truthy(env.WHATSAPP_ENABLED)) {
    channels.whatsapp = { enabled: true, dmPolicy: DM_OPEN, allowFrom: ALLOW_ALL };
    plugins.entries.whatsapp = { enabled: true };
  }
  if (truthy(env.WECHAT_ENABLED) || truthy(env.WEIXIN_ENABLED)) {
    channels["openclaw-weixin"] = { enabled: true, dmPolicy: DM_OPEN, allowFrom: ALLOW_ALL };
  }

  // ── Session ───────────────────────────────────────────────────
  // per-channel-peer：每个渠道的每个用户独立 session，互不干扰
  const session = { dmScope: "per-channel-peer" };

  // ── Tools ─────────────────────────────────────────────────────
  // profile=full：无限制，等同于不设置 profile（参考官方文档）
  const tools = { profile: "full" };

  // ── 组装最终配置 ──────────────────────────────────────────────
  const cfg = { gateway, session, tools, models, agents: { defaults: agentDefaults }, plugins, channels };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  console.log(`[direct-config] openclaw.json written (provider=${provider?.id ?? "none"})`);
  return cfg;
}
