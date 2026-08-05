// Pre-installed plugin discovery paths.
//
// The Dockerfile installs these plugins into OPENCLAW_PLUGINS_DIR (default
// /opt/openclaw-plugins), which lives OUTSIDE the /data volume. The image uses
// the consumer lockfile in resources/openclaw-plugin-bundle, so every exact
// plugin version and transitive dependency is reproducible at build time.
//
// OpenClaw's plugin discovery (discoverOpenClawPlugins → discoverFromPath)
// accepts arbitrary paths via `plugins.load.paths` and resolves each plugin's
// dependencies through the adjacent node_modules. Pointing load.paths at these
// fixed image paths means:
//   - zero runtime copy (unlike the old STATE_DIR/npm prebuilt → cp ~650MB)
//   - zero runtime npm install (no first-use 30-60s wait per channel)
//   - volume-mount-proof (the volume can't shadow /opt)
//
// Discovery only makes a plugin's code findable; activation still requires
// plugins.entries.<id>.enabled=true (set by auto-config for clawrouters and by
// runtime defaults for OneClaw orchestration and Channel plugins), so listing
// these paths here is harmless even when a given channel isn't configured.
//
// durable-work and employee-catalog are intentionally absent from both lists
// below. The Dockerfile copies their exact locked packages into OpenClaw's
// immutable dist/extensions tree. They call privileged Gateway APIs, which
// OpenClaw permits only for bundled or catalog-trusted official plugins. Adding
// their /opt paths or install records here would rediscover them with origin
// config/global and shadow the trusted bundled candidates.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_PLUGINS_DIR = "/opt/openclaw-plugins";
const BUNDLED_ORCHESTRATION_PLUGIN_IDS = [
  "oneclaw-workflows",
  "oneclaw-employee-catalog",
];

// npm package names of the plugins baked into the image (Dockerfile keeps this
// list in sync). Telegram is built into openclaw core — no plugin here.
// wechat uses the third-party @tencent-weixin/openclaw-weixin (channel id
// "openclaw-weixin"); there is no official wechat plugin.
const PREINSTALLED_PACKAGES = [
  "@oneclaw-plugins/clawrouters",
  "@oneclaw-plugins/openclaw-search",
  "@oneclaw-plugins/channel",
  "@openclaw/slack",
  "@openclaw/discord",
  "@openclaw/feishu",
  "@openclaw/whatsapp",
  "@tencent-weixin/openclaw-weixin",
];

const OFFICIAL_NPM_PLUGIN_INSTALLS = [
  { pluginId: "clawrouters", packageName: "@oneclaw-plugins/clawrouters" },
  { pluginId: "slack", packageName: "@openclaw/slack" },
  { pluginId: "discord", packageName: "@openclaw/discord" },
  { pluginId: "feishu", packageName: "@openclaw/feishu" },
  { pluginId: "whatsapp", packageName: "@openclaw/whatsapp" },
  { pluginId: "oneclaw-search", packageName: "@oneclaw-plugins/openclaw-search" },
  { pluginId: "oneclaw-channel", packageName: "@oneclaw-plugins/channel" },
];

const PREINSTALLED_PLUGIN_IDS = [
  "clawrouters",
  "oneclaw-search",
  "oneclaw-workflows",
  "oneclaw-employee-catalog",
  "oneclaw-channel",
  "slack",
  "discord",
  "feishu",
  "whatsapp",
  "openclaw-weixin",
];

// Returns the package directories that actually exist on disk. On a non-Docker
// dev box without the prebuilt /opt tree this returns [], and the caller simply
// omits plugins.load.paths (falling back to OpenClaw's lazy install).
export function resolvePreinstalledPluginPaths(env = process.env) {
  const base = path.join(env.OPENCLAW_PLUGINS_DIR?.trim() || DEFAULT_PLUGINS_DIR, "node_modules");
  return PREINSTALLED_PACKAGES
    .map((pkg) => path.join(base, ...pkg.split("/")))
    .filter((p) => fs.existsSync(p));
}

function readPackageVersion(packageDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function buildPreinstalledPluginInstallRecords(env = process.env) {
  const base = path.join(env.OPENCLAW_PLUGINS_DIR?.trim() || DEFAULT_PLUGINS_DIR, "node_modules");
  const installedAt = "1970-01-01T00:00:00.000Z";
  const records = {};

  for (const entry of OFFICIAL_NPM_PLUGIN_INSTALLS) {
    const installPath = path.join(base, ...entry.packageName.split("/"));
    if (!fs.existsSync(installPath)) continue;
    const version = readPackageVersion(installPath);
    records[entry.pluginId] = {
      source: "npm",
      spec: entry.packageName,
      resolvedName: entry.packageName,
      resolvedSpec: version ? `${entry.packageName}@${version}` : entry.packageName,
      ...(version ? { version, resolvedVersion: version } : {}),
      installPath,
      installedAt,
    };
  }

  return records;
}

export function applyPreinstalledPluginInstallRecords(cfg, env = process.env) {
  const records = buildPreinstalledPluginInstallRecords(env);
  let changed = false;

  for (const pluginId of BUNDLED_ORCHESTRATION_PLUGIN_IDS) {
    if (!Object.hasOwn(cfg.plugins?.installs || {}, pluginId)) continue;
    delete cfg.plugins.installs[pluginId];
    changed = true;
  }

  if (Object.keys(records).length > 0) {
    cfg.plugins ??= {};
    cfg.plugins.installs = {
      ...(cfg.plugins.installs || {}),
      ...records,
    };
    changed = true;
  }

  return changed;
}

export function cleanupStalePreinstalledExtensions(stateDir, env = process.env) {
  if (resolvePreinstalledPluginPaths(env).length === 0) return;
  const extensionsDir = path.join(stateDir, "extensions");
  for (const id of PREINSTALLED_PLUGIN_IDS) {
    const stalePath = path.join(extensionsDir, id);
    try {
      if (!fs.existsSync(stalePath)) continue;
      fs.rmSync(stalePath, { recursive: true, force: true });
      console.log(`[plugins] removed stale volume extension ${stalePath}`);
    } catch (err) {
      console.warn(`[plugins] failed to remove stale volume extension ${stalePath}: ${err.message}`);
    }
  }
}
