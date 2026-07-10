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
  return applyChannelAccountBinding(cfg, { channel, accountId, agentId, account: { enabled: true } });
}

export function applyChannelAccountBinding(cfg, { channel, accountId, agentId, account = {} }) {
  assertBindableChannel(channel);
  if (typeof accountId !== "string" || !accountId.trim()) throw new Error("accountId required");
  if (typeof agentId !== "string" || !agentId.trim()) throw new Error("agentId required");

  if (!cfg.channels || typeof cfg.channels !== "object") cfg.channels = {};
  if (!cfg.channels[channel] || typeof cfg.channels[channel] !== "object") cfg.channels[channel] = { enabled: true };
  cfg.channels[channel].enabled = true;
  if (!cfg.channels[channel].accounts || typeof cfg.channels[channel].accounts !== "object") cfg.channels[channel].accounts = {};
  cfg.channels[channel].accounts[accountId] = {
    ...(cfg.channels[channel].accounts[accountId] || {}),
    ...account,
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
  if (!Array.isArray(cfg.bindings)) cfg.bindings = [];

  const matches = cfg.bindings.filter(
    (b) => b?.match?.channel === channel && b?.match?.accountId === accountId && b?.agentId === agentId
  );
  cfg.bindings = cfg.bindings.filter(
    (b) => !(b?.match?.channel === channel && b?.match?.accountId === accountId && b?.agentId === agentId)
  );
  const channelConfig = cfg.channels?.[channel];
  const hasAccount = !!(channelConfig?.accounts && typeof channelConfig.accounts === "object" && channelConfig.accounts[accountId]);
  const ownsAccount = hasAccount && (matches.length > 0 || accountId === agentId);
  const isLegacySingleAccount = !!(channelConfig && (!channelConfig.accounts || typeof channelConfig.accounts !== "object"));
  if (matches.length === 0 && !ownsAccount && !isLegacySingleAccount) return result;
  if (channelConfig?.accounts && typeof channelConfig.accounts === "object") {
    delete cfg.channels[channel].accounts[accountId];
  }
  const remainingAccounts = channelConfig?.accounts && typeof channelConfig.accounts === "object"
    ? Object.keys(channelConfig.accounts)
    : [];
  let channelRemoved = false;
  if (isLegacySingleAccount || remainingAccounts.length === 0) {
    delete cfg.channels[channel];
    channelRemoved = true;
    if (cfg.plugins?.entries?.[channel]) cfg.plugins.entries[channel].enabled = false;
  }
  return { ...result, removed: true, ...(channelRemoved ? { channelRemoved: true } : {}) };
}
