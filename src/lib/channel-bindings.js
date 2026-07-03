export const BINDABLE_CHANNELS = new Set([
  "telegram",
  "discord",
  "feishu",
  "slack",
  "whatsapp",
  "openclaw-weixin",
]);

export function assertBindableChannel(channel) {
  if (typeof channel !== "string" || !BINDABLE_CHANNELS.has(channel)) {
    const allowed = Array.from(BINDABLE_CHANNELS).join(", ");
    throw new Error(`unsupported channel: ${channel}; allowed: ${allowed}`);
  }
}

export function readChannelBindings(cfg = {}) {
  const channels = {};
  for (const [id, value] of Object.entries(cfg.channels || {})) {
    const accounts = value?.accounts && typeof value.accounts === "object"
      ? Object.keys(value.accounts)
      : [];
    channels[id] = { enabled: !!value?.enabled, accounts };
  }

  const bindings = Array.isArray(cfg.bindings)
    ? cfg.bindings
        .filter((b) => typeof b?.agentId === "string" && typeof b?.match?.channel === "string" && typeof b?.match?.accountId === "string")
        .map((b) => ({ channel: b.match.channel, accountId: b.match.accountId, agentId: b.agentId }))
    : [];

  return { ok: true, bindings, channels };
}

export function applyChannelBinding(cfg, { channel, accountId, agentId }) {
  assertBindableChannel(channel);
  if (typeof accountId !== "string" || !accountId.trim()) throw new Error("accountId required");
  if (typeof agentId !== "string" || !agentId.trim()) throw new Error("agentId required");

  if (!cfg.channels || typeof cfg.channels !== "object") cfg.channels = {};
  if (!cfg.channels[channel] || typeof cfg.channels[channel] !== "object") cfg.channels[channel] = { enabled: true };
  cfg.channels[channel].enabled = true;
  if (!cfg.channels[channel].accounts || typeof cfg.channels[channel].accounts !== "object") cfg.channels[channel].accounts = {};
  cfg.channels[channel].accounts[accountId] = {
    ...(cfg.channels[channel].accounts[accountId] || {}),
    enabled: true,
  };

  if (!Array.isArray(cfg.bindings)) cfg.bindings = [];
  cfg.bindings = cfg.bindings.filter(
    (b) => !(b?.match?.channel === channel && b?.match?.accountId === accountId)
  );
  cfg.bindings.push({ agentId, match: { channel, accountId } });

  return { channel, accountId, agentId };
}

export function removeChannelBinding(cfg, { channel, accountId, agentId }) {
  assertBindableChannel(channel);
  if (typeof accountId !== "string" || !accountId.trim()) throw new Error("accountId required");
  if (typeof agentId !== "string" || !agentId.trim()) throw new Error("agentId required");

  const result = { removed: false, channel, accountId, agentId };
  if (!Array.isArray(cfg.bindings)) return result;

  const matches = cfg.bindings.filter(
    (b) => b?.match?.channel === channel && b?.match?.accountId === accountId && b?.agentId === agentId
  );
  if (matches.length === 0) return result;

  cfg.bindings = cfg.bindings.filter(
    (b) => !(b?.match?.channel === channel && b?.match?.accountId === accountId && b?.agentId === agentId)
  );
  if (cfg.channels?.[channel]?.accounts && typeof cfg.channels[channel].accounts === "object") {
    delete cfg.channels[channel].accounts[accountId];
  }
  return { ...result, removed: true };
}
