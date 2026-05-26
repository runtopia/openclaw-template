import fs from "node:fs";

// 标准 provider 的 env key 和 baseUrl 映射
const PROVIDER_ENV_MAP = {
  anthropic:  { envKey: "ANTHROPIC_API_KEY",            baseUrl: "https://api.anthropic.com/v1" },
  openai:     { envKey: "OPENAI_API_KEY",               baseUrl: "https://api.openai.com/v1" },
  gemini:     { envKey: "GOOGLE_GENERATIVE_AI_API_KEY", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  deepseek:   { envKey: "DEEPSEEK_API_KEY",             baseUrl: "https://api.deepseek.com/v1" },
  openrouter: { envKey: "OPENROUTER_API_KEY",           baseUrl: "https://openrouter.ai/api/v1" },
};

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
      return {
        apiKey: provider.apiKey,
        baseUrl: (provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, ""),
        model: bareModel,
        providerName,
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
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
