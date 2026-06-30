#!/usr/bin/env node
// Pre-startup config generator.
//
// Runs from start.sh (as the openclaw user, after chown) before exec-ing
// `openclaw gateway run`. Writes openclaw.json so the gateway boots directly
// without any interactive onboarding.
//
// Idempotent: if openclaw.json already has gateway.mode set (redeploy on a
// persisted Railway volume), it only patches the gateway token + channel
// tokens from the current env and exits.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const STATE_DIR = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR = process.env.OPENCLAW_WORKSPACE_DIR?.trim() || path.join(STATE_DIR, "workspace");
const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(STATE_DIR, "openclaw.json");
const PORT = Number(process.env.PORT || 8080);

// ── Resolve gateway token ─────────────────────────────────────────────────────
function resolveGatewayToken() {
  const envTok = (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN)?.trim();
  if (envTok) return envTok;
  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {}
  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(`[init-config] could not persist token: ${err.code || err.message}`);
  }
  return generated;
}

function isConfigured() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return false;
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return Boolean(data?.gateway?.mode);
  } catch { return false; }
}

function hasAutoConfigEnvVars() {
  return !!(
    process.env.ANTHROPIC_API_KEY?.trim() ||
    process.env.OPENAI_API_KEY?.trim() ||
    process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
    process.env.DEEPSEEK_API_KEY?.trim() ||
    process.env.OPENROUTER_API_KEY?.trim() ||
    process.env.CLAWROUTERS_KEY?.trim() ||
    process.env.CLAWROUTERS_API_KEY?.trim()
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

const gatewayToken = resolveGatewayToken();
// Export so the exec'd gateway process inherits it via env.
process.env.OPENCLAW_GATEWAY_TOKEN = gatewayToken;

if (!hasAutoConfigEnvVars()) {
  console.log("[init-config] no API keys — skipping (gateway will refuse to start without config)");
  process.exit(0);
}

if (isConfigured()) {
  console.log("[init-config] already configured — patching token + channels");
  const { patchConfig, setIn } = await import("./lib/openclaw-config.js");
  const { reconcileAllChannels } = await import("./lib/channel-manifest.js");
  const { resolvePreinstalledPluginPaths } = await import("./lib/preinstalled-plugins.js");
  const { patchClawroutersProviderBaseUrl } = await import("./lib/direct-config.js");

  patchConfig(CONFIG_PATH, (cfg) => {
    setIn(cfg, "gateway.auth.token", gatewayToken);
    setIn(cfg, "gateway.port", PORT);
    setIn(cfg, "gateway.bind", "lan");
    const loadPaths = resolvePreinstalledPluginPaths();
    if (loadPaths.length > 0) setIn(cfg, "plugins.load.paths", loadPaths);
    if (patchClawroutersProviderBaseUrl(cfg, process.env)) {
      console.log("[init-config] patched ClawRouters baseUrl from CLAWROUTERS_BASE_URL");
    }
  });

  reconcileAllChannels({ env: process.env, stateDir: STATE_DIR });
  console.log("[init-config] done");
  process.exit(0);
}

// ── Fresh instance ────────────────────────────────────────────────────────────
console.log("[init-config] generating openclaw.json...");
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });

const { generateConfigDirect } = await import("./lib/direct-config.js");

generateConfigDirect({
  configPath: CONFIG_PATH,
  workspaceDir: WORKSPACE_DIR,
  gatewayToken,
  port: PORT,
  env: process.env,
});

console.log("[init-config] done — gateway will start directly");
