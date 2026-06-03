// Channel manifest — single source of truth for channel detection and
// reconciliation config shapes consumed by server.js auto-config flow.
//
// Each channel entry declares:
//   - id: channel identifier matching openclaw CLI name
//   - envCheck: returns true when the env vars needed for this channel are present
//   - reconcileShape: the config object written to channels.<id> in openclaw.json
//   - pluginId: the plugin entry to enable (undefined for built-in channels like telegram)
//   - needsPairingClear: if true, clear <id>-pairing.json + <id>-allowFrom.json
//     before writing config (token channels that might have stale pairing state)
//
// Adding a new channel only requires a new entry here — no new reconcile function.
//
// reconcileAllChannels() writes directly to openclaw.json via patchConfig() rather
// than spawning `openclaw config set` subprocesses (~3-5s cold start each). This
// makes Railway redeploys on configured instances ~15-30s faster when multiple
// channels are active.

import path from "node:path";
import fs from "node:fs";
import { patchConfig, setIn } from "./openclaw-config.js";

function truthy(v) {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const DM_OPEN = "open";
const ALLOW_ALL = ["*"];

export const CHANNEL_MANIFEST = [
  {
    id: "telegram",
    kind: "token",
    envCheck(env) {
      return !!env.TELEGRAM_BOT_TOKEN?.trim();
    },
    reconcileShape(env) {
      return {
        enabled: true,
        dmPolicy: DM_OPEN,
        allowFrom: ALLOW_ALL,
        botToken: env.TELEGRAM_BOT_TOKEN.trim(),
        groupPolicy: "allowlist",
      };
    },
    needsPairingClear: true,
    // telegram is built into openclaw core — no pluginId
  },
  {
    id: "discord",
    kind: "token",
    pluginId: "discord",
    envCheck(env) {
      return !!env.DISCORD_BOT_TOKEN?.trim();
    },
    reconcileShape(env) {
      return {
        enabled: true,
        accounts: { default: { token: env.DISCORD_BOT_TOKEN.trim() } },
        dm: { policy: DM_OPEN, allowFrom: ALLOW_ALL },
        groupPolicy: "allowlist",
      };
    },
    needsPairingClear: true,
  },
  {
    id: "slack",
    kind: "token",
    pluginId: "slack",
    envCheck(env) {
      return !!(env.SLACK_BOT_TOKEN?.trim() && env.SLACK_APP_TOKEN?.trim());
    },
    reconcileShape(env) {
      return {
        enabled: true,
        botToken: env.SLACK_BOT_TOKEN.trim(),
        appToken: env.SLACK_APP_TOKEN.trim(),
      };
    },
    needsPairingClear: false,
  },
  {
    id: "openclaw-lark",
    kind: "token",
    pluginId: "openclaw-lark",
    envCheck(env) {
      return !!(env.FEISHU_APP_ID?.trim() && env.FEISHU_APP_SECRET?.trim());
    },
    reconcileShape(env) {
      return {
        enabled: true,
        appId: env.FEISHU_APP_ID.trim(),
        appSecret: env.FEISHU_APP_SECRET.trim(),
        dmPolicy: DM_OPEN,
        allowFrom: ALLOW_ALL,
      };
    },
    needsPairingClear: true,
  },
  {
    id: "whatsapp",
    kind: "qr",
    pluginId: "whatsapp",
    envCheck(env) {
      return truthy(env.WHATSAPP_ENABLED);
    },
    reconcileShape() {
      return { enabled: true, dmPolicy: DM_OPEN, allowFrom: ALLOW_ALL };
    },
    needsPairingClear: false,
  },
  // WeChat (openclaw-weixin) is intentionally NOT in this manifest.
  // Its channel id "openclaw-weixin" is only known to OpenClaw after the
  // @tencent-weixin/openclaw-weixin plugin loads. The CLI-based `config set
  // channels.openclaw-weixin` command fails with "unknown channel id" because
  // CLI commands don't load plugins from plugins.load.paths. WeChat has no
  // env credentials to reconcile anyway (QR login happens at runtime).
  // Plugin activation is handled by applyAutoConfig when WECHAT_ENABLED=1.
];

export function getActiveChannels(env = process.env) {
  return CHANNEL_MANIFEST.filter((ch) => ch.envCheck(env));
}

export function hasAnyChannelConfig(env = process.env) {
  return CHANNEL_MANIFEST.some((ch) => ch.envCheck(env));
}

export function clearPairingStore(channelId, stateDir) {
  const credDir = path.join(stateDir, "credentials");
  for (const suffix of ["pairing.json", "allowFrom.json"]) {
    const f = path.join(credDir, `${channelId}-${suffix}`);
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`[reconcile] cleared ${f}`);
      }
    } catch (err) {
      console.warn(`[reconcile] failed to clear ${f}: ${err.message}`);
    }
  }
}

// setChannelConfig — fast path: write directly to openclaw.json via patchConfig().
//
// Legacy CLI path (kept for reference):
//   openclaw config set --json channels.<id> <json>
//   openclaw config set --json plugins.entries.<id> {"enabled":true}
// Each call spawns a fresh Node.js process (~3-5s cold start). With 3-4 channels
// that's 18-40s of pure subprocess overhead on redeploy. Direct file write is ms.
//
// The ctx object still accepts {OPENCLAW_NODE, clawArgs, runCmd, stateDir} so
// callers don't need to change their signature.
export function setChannelConfig(channelId, cfgObj, ctx) {
  const { stateDir } = ctx;
  if (!stateDir) {
    console.warn(`[reconcile] setChannelConfig: stateDir missing in ctx, skipping channels.${channelId}`);
    return;
  }
  const configPath = path.join(stateDir, "openclaw.json");
  if (!fs.existsSync(configPath)) {
    console.warn(`[reconcile] setChannelConfig: ${configPath} does not exist, skipping`);
    return;
  }
  patchConfig(configPath, (cfg) => {
    setIn(cfg, `channels.${channelId}`, cfgObj);
    // Also enable the plugin entry if the channel has one. For channels already
    // written by generateConfigDirect() this is a no-op.
    const ch = CHANNEL_MANIFEST.find((c) => c.id === channelId);
    if (ch?.pluginId) setIn(cfg, `plugins.entries.${ch.pluginId}`, { enabled: true });
  });
  console.log(`[reconcile] channels.${channelId} written directly to openclaw.json`);
}

function reconcileChannel(ch, ctx) {
  console.log(`[reconcile] forcing channels.${ch.id} → dmPolicy=open, allowFrom=["*"]`);
  if (ch.needsPairingClear) clearPairingStore(ch.id, ctx.stateDir);
  const shape = ch.reconcileShape(ctx.env || process.env);
  setChannelConfig(ch.id, shape, ctx);
}

// reconcileAllChannels — synchronous now (no more subprocess awaiting).
// Kept async-compatible (returns a resolved Promise) so server.js callers
// don't need to change.
export async function reconcileAllChannels(ctx) {
  const active = getActiveChannels(ctx.env || process.env);
  for (const ch of active) {
    reconcileChannel(ch, ctx);
  }
}
