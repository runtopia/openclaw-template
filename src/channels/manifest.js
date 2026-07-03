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
import { patchConfig, setIn } from "../config/edit.js";
import { mergeChannelPolicy } from "./access-policy.js";

function truthy(v) {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

const DM_OPEN = "open";
const DM_PAIRING = "pairing";
const ALLOW_ALL = ["*"];
const APPROVAL_ONLY = {
  dmPolicy: DM_PAIRING,
  allowFrom: [],
  groupPolicy: "disabled",
  groupAllowFrom: [],
  groups: {},
};

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
    id: "feishu",
    kind: "token",
    pluginId: "feishu",
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
      return { enabled: true, ...APPROVAL_ONLY };
    },
    needsPairingClear: false,
  },
  {
    // WeChat = third-party @tencent-weixin/openclaw-weixin; channel id AND
    // plugin id are both "openclaw-weixin". No env credentials — QR login
    // happens at runtime; this entry just enables the channel + plugin so the
    // gateway starts the channel (and prints the QR).
    //
    // NOTE: WeChat used to be excluded here because the OLD reconcile path ran
    // `openclaw config set`, which fails with "unknown channel id" for a
    // not-yet-loaded plugin channel. reconcileAllChannels now writes openclaw.json
    // DIRECTLY via patchConfig (no CLI, no plugin-load requirement), so that
    // limitation is gone. Excluding it meant WECHAT_ENABLED=1 had no effect on
    // an already-configured instance (generateConfigDirect only runs on first
    // config), so enabling WeChat post-deploy silently did nothing.
    id: "openclaw-weixin",
    kind: "qr",
    pluginId: "openclaw-weixin",
    envCheck(env) {
      return truthy(env.WECHAT_ENABLED) || truthy(env.WEIXIN_ENABLED);
    },
    reconcileShape() {
      return { enabled: true, ...APPROVAL_ONLY };
    },
    needsPairingClear: false,
  },
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
    const ch = CHANNEL_MANIFEST.find((c) => c.id === channelId);
    if (ch?.kind === "qr") {
      const existing = cfg.channels?.[channelId] && typeof cfg.channels[channelId] === "object"
        ? cfg.channels[channelId]
        : {};
      setIn(cfg, `channels.${channelId}`, mergeChannelPolicy(existing, cfgObj));
    } else {
      const existing = cfg.channels?.[channelId] && typeof cfg.channels[channelId] === "object"
        ? cfg.channels[channelId]
        : {};
      setIn(cfg, `channels.${channelId}`, mergeChannelPolicy(existing, cfgObj));
    }
    // Also enable the plugin entry if the channel has one. For channels already
    // written by generateConfigDirect() this is a no-op.
    if (ch?.pluginId) setIn(cfg, `plugins.entries.${ch.pluginId}`, { enabled: true });
  });
  console.log(`[reconcile] channels.${channelId} written directly to openclaw.json`);
}

function reconcileChannel(ch, ctx) {
  console.log(`[reconcile] refreshing channels.${ch.id} while preserving existing access policy`);
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
