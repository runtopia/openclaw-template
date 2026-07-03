import fs from "node:fs";
import { resolveClawroutersApiBaseUrl } from "../lib/direct-config.js";

// 标准 provider 的 env key 和 baseUrl 映射
const PROVIDER_ENV_MAP = {
  anthropic:  { envKey: "ANTHROPIC_API_KEY",            baseUrl: "https://api.anthropic.com/v1",                                        api: "anthropic-messages" },
  openai:     { envKey: "OPENAI_API_KEY",               baseUrl: "https://api.openai.com/v1",                                           api: "openai-completions" },
  gemini:     { envKey: "GOOGLE_GENERATIVE_AI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",              api: "openai-completions" },
  deepseek:   { envKey: "DEEPSEEK_API_KEY",             baseUrl: "https://api.deepseek.com/v1",                                         api: "openai-completions" },
  openrouter: { envKey: "OPENROUTER_API_KEY",           baseUrl: "https://openrouter.ai/api/v1",                                        api: "openai-completions" },
};

// 直接从环境变量解析 repair 用的 key——这样修复助手在 auto-config 写入
// openclaw.json 之前就可以使用。
export function readEnvProviderKey(env = process.env) {
  const clawRoutersKey = (env.CLAWROUTERS_KEY || env.CLAWROUTERS_API_KEY)?.trim();
  if (clawRoutersKey) {
    const defaultModel = env.DEFAULT_MODEL?.trim() || "";
    const model = defaultModel.includes("/")
      ? defaultModel.split("/").slice(1).join("/")
      : (defaultModel || "auto");
    return {
      apiKey: clawRoutersKey,
      baseUrl: resolveClawroutersApiBaseUrl(env),
      model,
      providerName: "clawrouters",
      api: "openai-completions",
    };
  }
  for (const [providerName, mapping] of Object.entries(PROVIDER_ENV_MAP)) {
    const apiKey = env[mapping.envKey]?.trim();
    if (apiKey) {
      const defaultModel = env.DEFAULT_MODEL?.trim() || "";
      const model = defaultModel.includes("/")
        ? defaultModel.split("/").slice(1).join("/")
        : defaultModel;
      return {
        apiKey,
        baseUrl: mapping.baseUrl,
        model,
        providerName,
        api: mapping.api,
      };
    }
  }
  return null;
}

export function readDefaultProviderKey(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const primary = cfg?.agents?.defaults?.model?.primary || "";
    const providerName = primary.includes("/") ? primary.split("/")[0] : primary;
    if (!providerName) return null;

    const bareModel = primary.includes("/") ? primary.split("/").slice(1).join("/") : primary;

    // 优先从 models.providers.<name> 读（custom provider / ClawRouters 路径）
    const provider = cfg?.models?.providers?.[providerName];
    if (provider?.apiKey) {
      let baseUrl = (provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
      const api = provider.api || "openai-completions";
      // Anthropic-messages providers need baseUrl to end with /v1 so that appending /messages gives the correct path
      if (api === "anthropic-messages" && !baseUrl.endsWith("/v1")) {
        baseUrl += "/v1";
      }
      return {
        apiKey: provider.apiKey,
        baseUrl,
        model: bareModel,
        providerName,
        api,
      };
    }

    // 降级：从 cfg.env 读标准 provider 的 key
    const mapping = PROVIDER_ENV_MAP[providerName];
    if (mapping) {
      const apiKey = cfg?.env?.[mapping.envKey];
      if (apiKey) {
        return {
          apiKey,
          baseUrl: mapping.baseUrl,
          model: bareModel,
          providerName,
          api: mapping.api,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
