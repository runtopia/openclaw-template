import path from "node:path";

export const BROWSER_DISPLAY = ":99";

export function browserGatewayEnv(env = process.env) {
  return env.ONECLAW_BROWSER_ENABLED === "1"
    ? { DISPLAY: BROWSER_DISPLAY, OPENCLAW_BROWSER_HEADLESS: "0" } : {};
}

function headedArgs(args) {
  if (!Array.isArray(args)) return args;
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== "string") { result.push(arg); continue; }
    if (/^--headless(?:=|$)/i.test(arg) || /^--ozone-platform=headless$/i.test(arg)) continue;
    if (/^--display=/i.test(arg)) continue;
    if (arg === "--display") { i++; continue; }
    if (arg === "--ozone-platform" && args[i + 1] === "headless") { i++; continue; }
    result.push(arg);
  }
  return result;
}

// Only opt into the image's headed browser defaults when its desktop is enabled.
// Headed display is a managed invariant; unrelated settings and tool deny lists retain precedence.
export function applyBrowserDefaults(cfg, env = process.env) {
  if (env.ONECLAW_BROWSER_ENABLED !== "1") return false;
  const before = JSON.stringify(cfg);
  if (cfg.browser?.enabled === false || cfg.plugins?.entries?.browser?.enabled === false) return false;
  cfg.browser ??= {};
  cfg.browser.enabled ??= true;
  cfg.browser.defaultProfile ??= "openclaw";
  cfg.browser.executablePath ??= "/usr/bin/chromium";
  cfg.browser.headless = false;
  if (cfg.browser.profiles?.openclaw) cfg.browser.profiles.openclaw.headless = false;
  cfg.browser.attachOnly ??= false;
  cfg.browser.extraArgs = headedArgs(cfg.browser.extraArgs ?? ["--start-maximized", "--noerrdialogs"]);
  if (env.ONECLAW_BROWSER_NO_SANDBOX === "1") cfg.browser.noSandbox = true;
  // The pinned host may include browser in core rather than a standalone plugin.
  // A root browser block is sufficient; do not invent plugin registrations.
  cfg.tools ??= {};
  for (const tools of [cfg.tools, ...(cfg.agents?.list || []).map((agent) => agent.tools).filter(Boolean)]) {
    if (tools.profile === "coding" && !tools.deny?.includes("browser") && !Array.isArray(tools.allow)) {
      tools.alsoAllow ??= [];
      if (!tools.alsoAllow.includes("browser")) tools.alsoAllow.push("browser");
      if (env.ONECLAW_BROWSER_USE_ENABLED === "1" && !tools.deny?.includes("browser_use") && !tools.alsoAllow.includes("browser_use")) tools.alsoAllow.push("browser_use");
    }
  }
  if (env.ONECLAW_BROWSER_USE_ENABLED === "1") {
    cfg.browser.defaultProfile = "openclaw";
    cfg.plugins ??= {};
    cfg.plugins.entries ??= {};
    cfg.plugins.entries["oneclaw-browser-use"] ??= { enabled: true };
    cfg.plugins.load ??= {};
    cfg.plugins.load.paths ??= [];
    const pluginDir = env.ONECLAW_BROWSER_USE_PLUGIN_DIR || path.join(env.OPENCLAW_PLUGINS_DIR || "/opt/openclaw-plugins", "node_modules/@oneclaw-plugins/browser-use");
    if (!cfg.plugins.load.paths.includes(pluginDir)) cfg.plugins.load.paths.push(pluginDir);
    if (Array.isArray(cfg.plugins.allow) && !cfg.plugins.allow.includes("oneclaw-browser-use")) cfg.plugins.allow.push("oneclaw-browser-use");
  }
  return before !== JSON.stringify(cfg);
}
