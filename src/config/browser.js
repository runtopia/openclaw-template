// Only opt into the image's headed browser defaults when its desktop is enabled.
// Explicit user settings and tool deny lists retain precedence.
export function applyBrowserDefaults(cfg, env = process.env) {
  if (env.ONECLAW_BROWSER_ENABLED !== "1") return false;
  const before = JSON.stringify(cfg);
  if (cfg.browser?.enabled === false || cfg.plugins?.entries?.browser?.enabled === false) return false;
  cfg.browser ??= {};
  cfg.browser.enabled ??= true;
  cfg.browser.defaultProfile ??= "openclaw";
  cfg.browser.executablePath ??= "/usr/bin/chromium";
  cfg.browser.headless ??= false;
  cfg.browser.attachOnly ??= false;
  cfg.browser.extraArgs ??= ["--start-maximized", "--noerrdialogs"];
  if (env.ONECLAW_BROWSER_NO_SANDBOX === "1") cfg.browser.noSandbox = true;
  // The pinned host may include browser in core rather than a standalone plugin.
  // A root browser block is sufficient; do not invent plugin registrations.
  cfg.tools ??= {};
  for (const tools of [cfg.tools, ...(cfg.agents?.list || []).map((agent) => agent.tools).filter(Boolean)]) {
    if (tools.profile === "coding" && !tools.deny?.includes("browser") && !Array.isArray(tools.allow)) {
      tools.alsoAllow ??= [];
      if (!tools.alsoAllow.includes("browser")) tools.alsoAllow.push("browser");
    }
  }
  return before !== JSON.stringify(cfg);
}
