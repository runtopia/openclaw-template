// Auto-configuration from environment variables.

import fs from "node:fs";
import path from "node:path";
import { hasAnyChannelConfig, reconcileAllChannels } from "./channel-manifest.js";
import { ensureControlUiConfig } from "./control-ui-config.js";
import { patchConfig, setIn } from "./openclaw-config.js";

export function hasAutoConfigEnvVars(env = process.env) {
  const keys = [
    env.ANTHROPIC_API_KEY,
    env.OPENAI_API_KEY,
    env.GOOGLE_GENERATIVE_AI_API_KEY,
    env.DEEPSEEK_API_KEY,
    env.OPENROUTER_API_KEY,
    env.CLAWROUTERS_KEY,
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
  if (env.CLAWROUTERS_KEY?.trim()) {
    const baseUrl = env.ONECLAW_END_USER
      ? (env.CR_PROXY_BASE_URL || "http://127.0.0.1:18791/api/v1")
      : "https://www.clawrouters.com/api/v1";
    return {
      authChoice: "custom-api-key",
      authSecret: env.CLAWROUTERS_KEY.trim(),
      customBaseUrl: baseUrl,
      customModelId: "auto",
      customProviderId: "clawrouters",
      customCompatibility: "openai",
      customVision: true,
    };
  }
  return {};
}

function applyAutoConfig(ctx) {
  // Single-write strategy: every config change collected into one
  // patchConfig() call to avoid 10+ openclaw config-set subprocesses
  // (each ~3-5s cold start). controlUi stays in ensureControlUiConfig
  // because that helper is also called at server startup.
  const { env, stateDir, gatewayToken, internalGatewayPort } = ctx;
  const clawRoutersKey = env.CLAWROUTERS_KEY?.trim();
  const crBaseUrl = env.ONECLAW_END_USER
    ? (ctx.crProxyBaseUrl || "http://127.0.0.1:18791/api/v1")
    : "https://www.clawrouters.com/api/v1";
  const envKeys = {};
  if (env.ANTHROPIC_API_KEY?.trim()) envKeys.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY.trim();
  if (env.OPENAI_API_KEY?.trim()) envKeys.OPENAI_API_KEY = env.OPENAI_API_KEY.trim();
  if (env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) envKeys.GOOGLE_GENERATIVE_AI_API_KEY = env.GOOGLE_GENERATIVE_AI_API_KEY.trim();
  if (env.DEEPSEEK_API_KEY?.trim()) envKeys.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY.trim();

  patchConfig(path.join(stateDir, "openclaw.json"), (cfg) => {
    setIn(cfg, "gateway.auth.token", gatewayToken);
    setIn(cfg, "gateway.trustedProxies", ["127.0.0.1"]);

    if (env.DEFAULT_MODEL?.trim()) {
      setIn(cfg, "agents.defaults.model.primary", env.DEFAULT_MODEL.trim());
    }

    if (clawRoutersKey) {
      const visionModels = [
        { id: "auto",              name: "ClawRouters Auto",    input: ["text", "image"], contextWindow: 200000,  maxTokens: 8192  },
        { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6",   input: ["text", "image"], contextWindow: 200000,  maxTokens: 8192  },
        { id: "claude-haiku-4.5",  name: "Claude Haiku 4.5",    input: ["text", "image"], contextWindow: 200000,  maxTokens: 8192  },
        { id: "gpt-5.4",           name: "GPT-5.4",             input: ["text", "image"], contextWindow: 1050000, maxTokens: 16384 },
        { id: "gemini-3-pro",      name: "Gemini 3 Pro",        input: ["text", "image"], contextWindow: 1000000, maxTokens: 8192  },
      ];
      setIn(cfg, "models.providers.clawrouters", { baseUrl: crBaseUrl, apiKey: clawRoutersKey, api: "openai-completions", models: visionModels });
      setIn(cfg, "agents.defaults.model.primary", "clawrouters/auto");
      // Route openai provider through ClawRouters too — must include models[]
      // array to pass gateway config validation. gpt-image-1 is referenced by
      // imageGenerationModel below.
      setIn(cfg, "models.providers.openai", {
        baseUrl: crBaseUrl,
        apiKey: clawRoutersKey,
        models: [
          { id: "gpt-image-1", name: "GPT Image 1", input: ["text"], output: ["image"] },
        ],
      });
      setIn(cfg, "agents.defaults.imageGenerationModel", { primary: "openai/gpt-image-1" });
      for (const skillKey of ["openai-image-gen", "nano-banana-pro"]) {
        setIn(cfg, `skills.entries.${skillKey}`, { enabled: false });
      }
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

  const auth = resolveAuth(env);
  const onboardArgs = buildOnboardArgs({
    flow: "quickstart",
    ...auth,
    model: (env.DEFAULT_MODEL || "").trim() || "",
    workspaceDir,
    internalGatewayPort: ctx.internalGatewayPort,
    gatewayToken: ctx.gatewayToken,
  });

  console.log("[auto-config] running onboard...");
  const onboard = await ctx.runCmd(ctx.OPENCLAW_NODE, ctx.clawArgs(onboardArgs));
  console.log(`[auto-config] onboard exit=${onboard.code}`);
  if (onboard.output) console.log(onboard.output);

  if (onboard.code !== 0 || !isConfigured()) {
    console.error("[auto-config] onboard failed");
    return false;
  }

  await reconcileAllChannels({ env, stateDir, OPENCLAW_NODE: ctx.OPENCLAW_NODE, clawArgs: ctx.clawArgs, runCmd: ctx.runCmd });

  applyAutoConfig(ctx);

  // Safety net: run `openclaw doctor --fix` so any residual config validation
  // problems (e.g. missing provider models[] arrays, stale plugin entries)
  // are auto-repaired before gateway boots. Without this, a single config
  // schema drift could brick gateway startup.
  console.log("[auto-config] running doctor --fix to validate config...");
  const doctor = await ctx.runCmd(ctx.OPENCLAW_NODE, ctx.clawArgs(["doctor", "--fix", "--yes"]));
  console.log(`[auto-config] doctor exit=${doctor.code}`);
  if (doctor.output) console.log(doctor.output);

  console.log("[auto-config] BUILD_ID=v20260518-doctor-fix — config patch + doctor safety net");
  console.log("[auto-config] configuration complete!");
  return true;
}