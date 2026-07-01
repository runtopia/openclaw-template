const VALID_ACCESS_MODES = new Set(["approval", "allowlist", "public"]);
const VALID_GROUP_MODES = new Set(["disabled", "allowlist", "public"]);

export function defaultChannelAccessPolicy() {
  return {
    mode: "approval",
    allowFrom: [],
    groupMode: "disabled",
    groupAllowFrom: [],
    requireMention: true,
  };
}

function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeChannelAccessPolicy(value, fallback = defaultChannelAccessPolicy()) {
  if (!isObject(value)) {
    return {
      ...fallback,
      allowFrom: [...(fallback.allowFrom || [])],
      groupAllowFrom: [...(fallback.groupAllowFrom || [])],
    };
  }

  const mode = typeof value.mode === "string" && VALID_ACCESS_MODES.has(value.mode)
    ? value.mode
    : fallback.mode;
  const groupMode = typeof value.groupMode === "string" && VALID_GROUP_MODES.has(value.groupMode)
    ? value.groupMode
    : fallback.groupMode;

  return {
    mode,
    allowFrom: uniqueStrings(value.allowFrom),
    groupMode,
    groupAllowFrom: uniqueStrings(value.groupAllowFrom),
    requireMention: typeof value.requireMention === "boolean" ? value.requireMention : fallback.requireMention,
  };
}

export function buildRuntimeChannelAccessPolicy(accessInput) {
  const access = normalizeChannelAccessPolicy(accessInput);
  const runtime = {};

  if (access.mode === "approval") {
    runtime.dmPolicy = "pairing";
  } else if (access.mode === "allowlist") {
    runtime.dmPolicy = "allowlist";
    runtime.allowFrom = access.allowFrom;
  } else {
    runtime.dmPolicy = "open";
    runtime.allowFrom = ["*"];
  }

  if (access.groupMode === "disabled") {
    runtime.groupPolicy = "disabled";
  } else if (access.groupMode === "allowlist") {
    runtime.groupPolicy = "allowlist";
    runtime.groupAllowFrom = access.groupAllowFrom;
    runtime.groups = { "*": { requireMention: true } };
  } else {
    runtime.groupPolicy = "open";
    runtime.groups = { "*": { requireMention: access.requireMention !== false } };
  }

  return runtime;
}

function hasPolicy(value) {
  if (!isObject(value)) return false;
  return (
    typeof value.dmPolicy === "string" ||
    typeof value.groupPolicy === "string" ||
    Array.isArray(value.allowFrom) ||
    isObject(value.dm)
  );
}

export function mergeChannelPolicy(existing, incoming) {
  if (!isObject(existing)) return incoming;
  if (!isObject(incoming)) return existing;

  const merged = { ...existing, ...incoming };
  if (hasPolicy(existing)) {
    for (const key of ["dmPolicy", "allowFrom", "groupPolicy", "groupAllowFrom", "groups", "dm"]) {
      if (existing[key] !== undefined) {
        merged[key] = existing[key];
      } else {
        delete merged[key];
      }
    }
  }
  if (isObject(existing.accounts)) {
    merged.accounts = existing.accounts;
  }
  return merged;
}

export function applyChannelPolicy(cfg, { channel, accountId, access }) {
  if (typeof channel !== "string" || !channel.trim()) throw new Error("channel required");
  const runtimePolicy = buildRuntimeChannelAccessPolicy(access);
  if (!cfg.channels || typeof cfg.channels !== "object") cfg.channels = {};
  if (!cfg.channels[channel] || typeof cfg.channels[channel] !== "object") cfg.channels[channel] = { enabled: true };
  cfg.channels[channel].enabled = true;

  if (typeof accountId === "string" && accountId.trim()) {
    if (!cfg.channels[channel].accounts || typeof cfg.channels[channel].accounts !== "object") {
      cfg.channels[channel].accounts = {};
    }
    const existing = cfg.channels[channel].accounts[accountId] || {};
    cfg.channels[channel].accounts[accountId] = {
      ...existing,
      enabled: true,
      ...runtimePolicy,
    };
    return cfg.channels[channel].accounts[accountId];
  }

  Object.assign(cfg.channels[channel], runtimePolicy);
  return cfg.channels[channel];
}
