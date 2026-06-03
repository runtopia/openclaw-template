// Auto-configuration from environment variables.

import fs from "node:fs";
import path from "node:path";
import { ensureControlUiConfig } from "./control-ui-config.js";
import { patchConfig, setIn } from "./openclaw-config.js";
import { resolvePreinstalledPluginPaths } from "./preinstalled-plugins.js";
import { generateConfigDirect } from "./direct-config.js";

function truthy(v) {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

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
      customBaseUrl: "https://www.clawrouters.com/api/v1",
      customModelId: "auto",
      customProviderId: "clawrouters",
      customCompatibility: "openai",
      customVision: true,
    };
  }
  return {};
}

// applyAutoConfig patches an already-existing openclaw.json with additional env-driven
// overrides (plugins.load.paths, clawrouters model entries, WeChatplugin toggle, etc.).
// When generateConfigDirect() is used, these fields are already baked in — this function
// is kept for the setup-wizard path (which still runs `openclaw onboard`) and for
// Railway redeploys where openclaw.json already exists.
function applyAutoConfig(ctx) {
  const { env, stateDir, gatewayToken, internalGatewayPort } = ctx;
  const clawRoutersKey = (env.CLAWROUTERS_KEY || env.CLAWROUTERS_API_KEY)?.trim();
  const envKeys = {};
  if (env.ANTHROPIC_API_KEY?.trim()) envKeys.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY.trim();
  if (env.OPENAI_API_KEY?.trim()) envKeys.OPENAI_API_KEY = env.OPENAI_API_KEY.trim();
  if (env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) envKeys.GOOGLE_GENERATIVE_AI_API_KEY = env.GOOGLE_GENERATIVE_AI_API_KEY.trim();
  if (env.DEEPSEEK_API_KEY?.trim()) envKeys.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY.trim();

  patchConfig(path.join(stateDir, "openclaw.json"), (cfg) => {
    setIn(cfg, "gateway.auth.token", gatewayToken);
    setIn(cfg, "gateway.trustedProxies", ["127.0.0.1"]);

    // Point OpenClaw at the image-baked plugins (clawrouters/discord/feishu)
    // so they're discovered without a runtime npm install. See
    // preinstalled-plugins.js for why this lives outside the volume.
    const loadPaths = resolvePreinstalledPluginPaths(env);
    if (loadPaths.length > 0) setIn(cfg, "plugins.load.paths", loadPaths);

    if (env.DEFAULT_MODEL?.trim()) {
      setIn(cfg, "agents.defaults.model.primary", env.DEFAULT_MODEL.trim());
    }

    if (clawRoutersKey) {
      // Use SecretRef so the raw key is never written to openclaw.json.
      // CLAWROUTERS_KEY is normalized to CLAWROUTERS_API_KEY in start.sh.
      setIn(cfg, "models.providers.clawrouters", {
        baseUrl: "https://www.clawrouters.com/api/v1",
        apiKey: { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" },
        api: "openai-completions",
        models: [
          { id: "auto", name: "auto", input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        ],
      });
      setIn(cfg, "agents.defaults.model.primary", "clawrouters/auto");
      setIn(cfg, "agents.defaults.imageGenerationModel", { primary: "clawrouters-image/auto" });
      setIn(cfg, "agents.defaults.videoGenerationModel", { primary: "clawrouters-video/auto", timeoutMs: 600000 });
      setIn(cfg, "agents.defaults.mediaGenerationAutoProviderFallback", false);
      setIn(cfg, "plugins.entries.clawrouters", { enabled: true });
      for (const skillKey of ["openai-image-gen", "nano-banana-pro"]) {
        setIn(cfg, `skills.entries.${skillKey}`, { enabled: false });
      }
    }

    // WeChat: just enable the plugin. The channel id "openclaw-weixin" is only
    // registered after the plugin loads, so we can't write channels config via
    // CLI (it would fail with "unknown channel id"). Plugin activation is enough;
    // the user scans the QR via `openclaw channels login` at runtime.
    if (truthy(env.WECHAT_ENABLED) || truthy(env.WEIXIN_ENABLED)) {
      setIn(cfg, "plugins.entries.openclaw-weixin", { enabled: true });
    }

    if (Object.keys(envKeys).length > 0) {
      setIn(cfg, "env", { ...(cfg.env || {}), ...envKeys });
    }
  });

  ensureControlUiConfig({
    configPath: path.join(stateDir, "openclaw.json"),
    port: env?.PORT || process.env.PORT || 8080,
    internalGatewayHost: env?.INTERNAL_GATEWAY_HOST || "127.0.0.1",
    internalGatewayPort,
    allowedOriginsEnv: env?.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS,
  });
}

export async function autoConfigureFromEnv(ctx) {
  const { isConfigured, env = process.env, workspaceDir, stateDir } = ctx;

  if (isConfigured()) {
    console.log("[auto-config] already configured, skipping");
    return true;
  }
  if (!hasAutoConfigEnvVars(env)) {
    console.log("[auto-config] no API keys in env vars, skipping");
    return false;
  }

  console.log("[auto-config] configuring from environment variables...");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(stateDir, "credentials"), { recursive: true });

  // ── Fast path: generate openclaw.json directly (no subprocess) ──────────────
  // This replaces `openclaw onboard --non-interactive` (which costs 30-60s on a
  // cold instance) with an in-process JSON write (sub-ms). The resulting config
  // is functionally equivalent: same gateway fields, same provider shape, same
  // plugin paths, same channel tokens.
  console.log("[auto-config] generating openclaw.json in-process (skipping onboard CLI)...");
  try {
    generateConfigDirect({
      configPath: path.join(stateDir, "openclaw.json"),
      workspaceDir,
      gatewayToken: ctx.gatewayToken,
      gatewayPort: ctx.internalGatewayPort,
      gatewayHost: process.env.INTERNAL_GATEWAY_HOST || "127.0.0.1",
      wrapperPort: Number(env.PORT || process.env.PORT || 8080),
      env,
      allowedOriginsEnv: env.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS,
    });
  } catch (err) {
    console.error(`[auto-config] direct config generation failed: ${err.message}`);
    return false;
  }

  if (!isConfigured()) {
    console.error("[auto-config] openclaw.json written but isConfigured() still false — gateway.mode missing?");
    return false;
  }

  console.log("[auto-config] openclaw.json ready — skipping onboard + doctor subprocesses");
  console.log("[auto-config] BUILD_ID=v20260603-direct-config — zero-subprocess fast path");
  console.log("[auto-config] configuration complete!");
  return true;
}
