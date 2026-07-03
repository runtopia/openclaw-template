// Single source of truth for gateway.controlUi settings the wrapper needs.
//
// Why this exists:
//   - The wrapper rewrites browser Origin to GATEWAY_ORIGIN (http://INTERNAL_GATEWAY_HOST:INTERNAL_GATEWAY_PORT)
//     before proxying, so that origin MUST be in gateway.controlUi.allowedOrigins.
//   - The Control UI uses relative asset paths (./sw.js, ./manifest.webmanifest, …).
//     Without controlUi.basePath="/openclaw" the gateway treats /openclaw/sw.js as a
//     non-control-ui path → 404 for the service worker, manifest, icons.
//   - Direct file write is more reliable than `openclaw config set` (CLI subprocess
//     can mix stderr noise into stdout, may normalize/strip unknown fields, and is
//     slower).
//
// Called from:
//   - server.js startup (after isConfigured()=true) — covers Railway redeploys and
//     stale configs from older wrapper versions
//   - setup.js after onboard — covers fresh setup-wizard installs
//   - auto-config.js after onboard — covers env-var driven auto-config

import fs from "node:fs";

export function ensureControlUiConfig({ configPath, port, internalGatewayHost, internalGatewayPort, allowedOriginsEnv }) {
  if (!fs.existsSync(configPath)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!config.gateway) return false;
    if (!config.gateway.controlUi) config.gateway.controlUi = {};
    const controlUi = config.gateway.controlUi;

    controlUi.allowInsecureAuth = true;
    controlUi.dangerouslyDisableDeviceAuth = true;
    controlUi.basePath = "/openclaw";

    const existing = Array.isArray(controlUi.allowedOrigins) ? controlUi.allowedOrigins : [];
    let merged;
    if (allowedOriginsEnv?.trim()) {
      merged = allowedOriginsEnv.split(",").map((o) => o.trim()).filter(Boolean);
    } else {
      merged = [...existing];
      const required = [
        `http://localhost:${port}`,
        `http://127.0.0.1:${port}`,
        `http://${internalGatewayHost}:${internalGatewayPort}`,
        "https://oneclaw.net",
        "https://www.oneclaw.net",
      ];
      for (const url of required) {
        if (!merged.includes(url)) merged.push(url);
      }
    }
    controlUi.allowedOrigins = merged;

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`[control-ui-config] patched: basePath=/openclaw, allowedOrigins=${merged.length}`);
    return true;
  } catch (err) {
    console.warn(`[control-ui-config] failed: ${err.message}`);
    return false;
  }
}
