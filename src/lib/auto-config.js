// Auto-configuration from environment variables.

import fs from "node:fs";
import path from "node:path";
import { hasAnyChannelConfig, reconcileAllChannels } from "./channel-manifest.js";
import { ensureControlUiConfig } from "./control-ui-config.js";

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
    "--no-install-daemon", "--skip-health", "--skip-skills",
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

async function configureGatewaySettings(ctx) {
  const { runCmd, OPENCLAW_NODE, clawArgs, gatewayToken, stateDir, internalGatewayPort } = ctx;
  console.log("[auto-config] configuring gateway settings...");
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", gatewayToken]));
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]']));
  // controlUi config (basePath, allowInsecureAuth, allowedOrigins including the
  // wrapper's rewritten Origin) is owned by ensureControlUiConfig.
  ensureControlUiConfig({
    configPath: path.join(stateDir, "openclaw.json"),
    port: ctx.env?.PORT || process.env.PORT || 8080,
    internalGatewayHost: ctx.env?.INTERNAL_GATEWAY_HOST || "127.0.0.1",
    internalGatewayPort,
    allowedOriginsEnv: ctx.env?.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS,
  });
}

async function configureClawRoutersProvider(ctx) {
  const clawRoutersKey = ctx.env.CLAWROUTERS_KEY?.trim();
  if (!clawRoutersKey) return;
  const { runCmd, OPENCLAW_NODE, clawArgs } = ctx;
  const baseUrl = ctx.env.ONECLAW_END_USER
    ? (ctx.crProxyBaseUrl || "http://127.0.0.1:18791/api/v1")
    : "https://www.clawrouters.com/api/v1";

  console.log(`[auto-config] configuring ClawRouters provider (baseUrl=${baseUrl})...`);
  const visionModels = [
    { id: "auto",              name: "ClawRouters Auto",    input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
    { id: "claude-sonnet-4.6", name: "Claude Sonnet 4.6",   input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
    { id: "claude-haiku-4.5",  name: "Claude Haiku 4.5",    input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
    { id: "gpt-5.4",           name: "GPT-5.4",             input: ["text", "image"], contextWindow: 1050000, maxTokens: 16384 },
    { id: "gemini-3-pro",      name: "Gemini 3 Pro",        input: ["text", "image"], contextWindow: 1000000, maxTokens: 8192 },
  ];
  const crProvider = { baseUrl, apiKey: clawRoutersKey, api: "openai-completions", models: visionModels };
  const crResult = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "models.providers.clawrouters", JSON.stringify(crProvider)]));
  console.log(`[auto-config] ClawRouters provider exit=${crResult.code}`);

  const modelResult = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "agents.defaults.model.primary", "clawrouters/auto"]));
  console.log(`[auto-config] default model set exit=${modelResult.code}`);

  const openaiOverride = { baseUrl, apiKey: clawRoutersKey };
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "models.providers.openai", JSON.stringify(openaiOverride)]));

  const imageGenConfig = { primary: "openai/gpt-image-1" };
  await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "agents.defaults.imageGenerationModel", JSON.stringify(imageGenConfig)]));

  for (const skillKey of ["openai-image-gen", "nano-banana-pro"]) {
    await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", `skills.entries.${skillKey}`, JSON.stringify({ enabled: false })]));
  }
}

async function setAdditionalApiKeys(ctx) {
  const { runCmd, OPENCLAW_NODE, clawArgs, env } = ctx;
  const envKeys = {};
  if (env.ANTHROPIC_API_KEY?.trim()) envKeys.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY.trim();
  if (env.OPENAI_API_KEY?.trim()) envKeys.OPENAI_API_KEY = env.OPENAI_API_KEY.trim();
  if (env.GOOGLE_GENERATIVE_AI_API_KEY?.trim()) envKeys.GOOGLE_GENERATIVE_AI_API_KEY = env.GOOGLE_GENERATIVE_AI_API_KEY.trim();
  if (env.DEEPSEEK_API_KEY?.trim()) envKeys.DEEPSEEK_API_KEY = env.DEEPSEEK_API_KEY.trim();
  if (Object.keys(envKeys).length > 0) {
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "env", JSON.stringify(envKeys)]));
    console.log(`[auto-config] env keys set exit=${r.code}`);
  }
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
  await configureGatewaySettings(ctx);

  if (env.DEFAULT_MODEL?.trim()) {
    await ctx.runCmd(ctx.OPENCLAW_NODE, ctx.clawArgs(["models", "set", env.DEFAULT_MODEL.trim()]));
  }

  await configureClawRoutersProvider(ctx);
  await setAdditionalApiKeys(ctx);

  console.log("[auto-config] BUILD_ID=v20260424a — vision models + image_generate via ClawRouters");
  console.log("[auto-config] configuration complete!");
  return true;
}