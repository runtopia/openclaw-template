// Channel manifest — single source of truth for channel detection and
// reconciliation config shapes consumed by server.js auto-config flow.
//
// Each channel entry declares:
//   - id: channel identifier matching openclaw CLI name
//   - envCheck: returns true when the env vars needed for this channel are present
//   - reconcileShape: the config object written via `openclaw config set --json channels.<id>`
//   - needsPairingClear: if true, clear <id>-pairing.json + <id>-allowFrom.json
//     before writing config (token channels that might have stale pairing state)
//
// Adding a new channel only requires a new entry here — no new reconcile function.

import path from "node:path";
import fs from "node:fs";

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
  },
  {
    id: "discord",
    kind: "token",
    envCheck(env) {
      return !!env.DISCORD_BOT_TOKEN?.trim();
    },
    reconcileShape(env) {
      return {
        enabled: true,
        token: env.DISCORD_BOT_TOKEN.trim(),
        dm: { policy: DM_OPEN, allowFrom: ALLOW_ALL },
        groupPolicy: "allowlist",
      };
    },
    needsPairingClear: true,
  },
  {
    id: "slack",
    kind: "token",
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

export async function setChannelConfig(channelId, cfgObj, { OPENCLAW_NODE, clawArgs, runCmd }) {
  const r1 = await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "--json", `channels.${channelId}`, JSON.stringify(cfgObj),
  ]));
  console.log(`[reconcile] channels.${channelId} exit=${r1.code}`);
  if (r1.output) console.log(r1.output);

  const r2 = await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "--json", `plugins.entries.${channelId}`, '{"enabled":true}',
  ]));
  console.log(`[reconcile] plugins.entries.${channelId} exit=${r2.code}`);
  if (r2.output) console.log(r2.output);
}

async function reconcileChannel(ch, ctx) {
  console.log(`[reconcile] forcing channels.${ch.id} → dmPolicy=open, allowFrom=["*"]`);
  if (ch.needsPairingClear) clearPairingStore(ch.id, ctx.stateDir);
  const shape = ch.reconcileShape(ctx.env || process.env);
  await setChannelConfig(ch.id, shape, ctx);
}

export async function reconcileAllChannels(ctx) {
  const active = getActiveChannels(ctx.env || process.env);
  for (const ch of active) {
    await reconcileChannel(ch, ctx);
  }
}