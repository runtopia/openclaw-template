import fs from "node:fs";

export function readDefaultProviderKey(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const primary = cfg?.agents?.defaults?.model?.primary || "";
    const providerName = primary.includes("/") ? primary.split("/")[0] : primary;
    if (!providerName) return null;
    const provider = cfg?.models?.providers?.[providerName];
    if (!provider?.apiKey) return null;
    return {
      apiKey: provider.apiKey,
      baseUrl: (provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: primary.includes("/") ? primary.split("/").slice(1).join("/") : primary,
      providerName,
    };
  } catch {
    return null;
  }
}
