// Pre-installed plugin discovery paths.
//
// The Dockerfile installs these plugins into OPENCLAW_PLUGINS_DIR (default
// /opt/openclaw-plugins), which lives OUTSIDE the /data volume. Each plugin
// ships an npm-shrinkwrap.json, so npm nests every dependency under the
// plugin's own node_modules — the package directories are fully self-contained.
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
// the channel plan for discord/feishu), so listing all paths here is harmless
// even when a given channel isn't configured.

import fs from "node:fs";
import path from "node:path";

const DEFAULT_PLUGINS_DIR = "/opt/openclaw-plugins";

// npm package names of the plugins baked into the image (Dockerfile keeps this
// list in sync). Telegram is built into openclaw core — no plugin here.
// wechat uses the third-party @tencent-weixin/openclaw-weixin (channel id
// "openclaw-weixin"); there is no official wechat plugin.
const PREINSTALLED_PACKAGES = [
  "@oneclaw/clawrouters",
  "@openclaw/slack",
  "@openclaw/discord",
  "@larksuite/openclaw-lark",
  "@openclaw/whatsapp",
  "@tencent-weixin/openclaw-weixin",
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
