import fs from "node:fs";

export function readDefaultProviderKey(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const primary = cfg?.agents?.defaults?.model?.primary || "";
    const providerName = primary.includes("/") ? primary.split("/")[0] : primary;

    // 优先尝试主 provider
    if (providerName) {
      const provider = cfg?.models?.providers?.[providerName];
      if (provider?.apiKey) {
        return {
          apiKey: provider.apiKey,
          baseUrl: (provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, ""),
          model: primary.includes("/") ? primary.split("/").slice(1).join("/") : primary,
          providerName,
        };
      }
    }

    // 降级：扫所有 provider，找任意有 apiKey + baseUrl 的（OpenAI-compatible）
    for (const [name, prov] of Object.entries(cfg?.models?.providers || {})) {
      if (prov?.apiKey && prov?.baseUrl) {
        const firstModelId = prov.models?.[0]?.id || "auto";
        return {
          apiKey: prov.apiKey,
          baseUrl: prov.baseUrl.replace(/\/$/, ""),
          model: firstModelId,
          providerName: name,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}
