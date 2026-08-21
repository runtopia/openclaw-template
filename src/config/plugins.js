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
// plugins.entries.<id>.enabled=true (set by auto-config and runtime defaults
// for credential-backed ClawRouters, and by runtime defaults for OneClaw
// Channel), so listing
// these paths here is harmless even when a given channel isn't configured.
//
// Channel is intentionally absent from both lists below. The Dockerfile copies
// its exact locked package into OpenClaw's immutable dist/extensions tree, then
// removes the ordinary /opt copy. It calls privileged Gateway APIs, which
// OpenClaw permits only for bundled or catalog-trusted official plugins. Adding
// or retaining its /opt path or install record would shadow the trusted copy.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_PLUGINS_DIR = "/opt/openclaw-plugins";
const NON_DISCOVERABLE_PLUGIN_INSTALL_IDS = [
  "oneclaw-channel",
  // Retired native-orchestration predecessors. Remove persisted install
  // records left by older cloud images even though they are no longer shipped.
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
  { pluginId: "openclaw-weixin", packageName: "@tencent-weixin/openclaw-weixin" },
  { pluginId: "oneclaw-search", packageName: "@oneclaw-plugins/openclaw-search" },
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

export function removeLegacyPreinstalledPluginInstallRecords(cfg, env = process.env) {
  const records = buildPreinstalledPluginInstallRecords(env);
  const legacyRecordIds = new Set([
    ...NON_DISCOVERABLE_PLUGIN_INSTALL_IDS,
    ...Object.keys(records),
  ]);
  let changed = false;

  // OpenClaw 2026.7.1-2 owns install metadata in state/openclaw.sqlite.
  // Remove legacy JSON records so startup migration cannot compete with the
  // canonical SQLite records synchronized before Gateway launch.
  for (const pluginId of legacyRecordIds) {
    if (!Object.hasOwn(cfg.plugins?.installs || {}, pluginId)) continue;
    delete cfg.plugins.installs[pluginId];
    changed = true;
  }
  if (cfg.plugins?.installs && Object.keys(cfg.plugins.installs).length === 0) {
    delete cfg.plugins.installs;
  }

  return changed;
}

function isExpectedManagedProject(projectDir, packageName, pluginId) {
  const packageDir = path.join(projectDir, "node_modules", ...packageName.split("/"));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(packageDir, "openclaw.plugin.json"), "utf8"),
    );
    return pkg.name === packageName && manifest.id === pluginId;
  } catch {
    return false;
  }
}

export function cleanupStalePreinstalledExtensions(
  stateDir,
  env = process.env,
  { installIndexReady = false } = {},
) {
  if (!installIndexReady || resolvePreinstalledPluginPaths(env).length === 0) return;
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

  // OpenClaw Doctor's npm installer creates one isolated project per package.
  // Once SQLite points at the immutable /opt copy, remove only projects whose
  // package and plugin identities exactly match an image-preinstalled plugin.
  const projectsDir = path.join(stateDir, "npm", "projects");
  let projects = [];
  try {
    projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(projectsDir, entry.name));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[plugins] failed to scan stale npm projects: ${err.message}`);
    }
  }
  for (const projectDir of projects) {
    const matched = OFFICIAL_NPM_PLUGIN_INSTALLS.some(({ pluginId, packageName }) =>
      isExpectedManagedProject(projectDir, packageName, pluginId));
    if (!matched) continue;
    try {
      fs.rmSync(projectDir, { recursive: true, force: true });
      console.log(`[plugins] removed stale managed npm project ${projectDir}`);
    } catch (err) {
      console.warn(`[plugins] failed to remove stale npm project ${projectDir}: ${err.message}`);
    }
  }
}
