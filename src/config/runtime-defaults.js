// Runtime defaults applied to an existing openclaw.json in memory.
// Extracted from generate.js so callers that only need patching don't
// pull in the full config-generation machinery.
//
// generate.js imports and re-exports applyRuntimeDefaults (and the two
// shared helpers below) so the public API of generate.js is unchanged.

import { applyPreinstalledSkillsDefaults } from "./preinstalled-skills.js";

const DEFAULT_HEARTBEAT = { every: "2h", target: "last" };
const CLAWROUTERS_API_KEY_REF = { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" };
const CLAWROUTERS_EMBEDDING_MODEL = "oneclaw-memory-v1";
const CLAWROUTERS_MANAGED_VOICE_MARKER = "oneclaw-clawrouters";
const OPENAI_VOICE_PROVIDER_ID = "openai";
const LEGACY_CLAWROUTERS_VOICE_PROVIDER_ID = "oneclaw-cr-voice";
const CLAWROUTERS_REALTIME_VOICES = new Set([
  "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse",
  "marin", "cedar",
]);
const ONECLAW_SEARCH_PLUGIN_ID = "oneclaw-search";
const ONECLAW_SEARCH_PROVIDER_ID = "oneclaw-search";
const ONECLAW_CHANNEL_PLUGIN_ID = "oneclaw-channel";
const WORKBOARD_PLUGIN_ID = "workboard";
const RETIRED_ONECLAW_COLLABORATION_PLUGIN_IDS = new Set([
  "oneclaw-workflows",
  "oneclaw-employee-catalog",
]);
const OPENCLAW_PROVIDER_PINNED_AGENT_RUNTIME = {
  openai: "pi",
  "openai-codex": "pi",
};

// ── Shared helpers (also re-exported via generate.js) ────────────────────────

export function resolveClawroutersApiBaseUrl(env = process.env) {
  const raw = (env.CLAWROUTERS_BASE_URL || "https://www.clawrouters.com").trim();
  const base = raw.replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

export function buildClawroutersMemorySearch(env = process.env) {
  return {
    enabled: true,
    sources: ["memory", "sessions"],
    provider: "clawrouters",
    model: CLAWROUTERS_EMBEDDING_MODEL,
    remote: {
      // OpenClaw appends /embeddings internally, so keep this at the /api/v1 base.
      baseUrl: resolveClawroutersApiBaseUrl(env),
      apiKey: CLAWROUTERS_API_KEY_REF,
    },
  };
}

// ── Private helpers ───────────────────────────────────────────────────────────

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function ensureObject(parent, key) {
  if (!parent[key] || typeof parent[key] !== "object" || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function setJsonValue(parent, key, value) {
  if (jsonEqual(parent[key], value)) return false;
  parent[key] = value;
  return true;
}

function hasClawroutersKey(env = process.env) {
  return Boolean((env.CLAWROUTERS_KEY || env.CLAWROUTERS_API_KEY)?.trim());
}

function buildClawroutersProviderShape(env) {
  return {
    baseUrl: resolveClawroutersApiBaseUrl(env),
    apiKey: CLAWROUTERS_API_KEY_REF,
    api: "openai-completions",
    models: [
      { id: "auto", name: "auto", input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ],
  };
}

function applyClawroutersMemorySearchPatch(defaults, env) {
  const memorySearch = ensureObject(defaults, "memorySearch");
  const desired = buildClawroutersMemorySearch(env);
  let changed = false;
  changed = setJsonValue(memorySearch, "enabled", desired.enabled) || changed;
  changed = setJsonValue(memorySearch, "sources", desired.sources) || changed;
  changed = setJsonValue(memorySearch, "provider", desired.provider) || changed;
  changed = setJsonValue(memorySearch, "model", desired.model) || changed;
  const remote = ensureObject(memorySearch, "remote");
  changed = setJsonValue(remote, "baseUrl", desired.remote.baseUrl) || changed;
  changed = setJsonValue(remote, "apiKey", desired.remote.apiKey) || changed;
  return changed;
}

function isClawroutersApiKeyRef(value) {
  return isObject(value)
    && value.source === CLAWROUTERS_API_KEY_REF.source
    && value.provider === CLAWROUTERS_API_KEY_REF.provider
    && value.id === CLAWROUTERS_API_KEY_REF.id;
}

function applyClawroutersManagedTtsPatch(cfg, env) {
  const existingMessages = isObject(cfg.messages) ? cfg.messages : {};
  const messages = { ...existingMessages };
  const existingTts = isObject(messages.tts) ? messages.tts : {};
  const tts = { ...existingTts };
  const existingProviders = isObject(tts.providers) ? tts.providers : {};
  const providers = { ...existingProviders };
  const existingOpenai = isObject(providers[OPENAI_VOICE_PROVIDER_ID])
    ? providers[OPENAI_VOICE_PROVIDER_ID]
    : {};
  const managedOpenai = isClawroutersApiKeyRef(existingOpenai.apiKey);
  const selectedProvider = typeof tts.provider === "string" ? tts.provider.trim() : "";
  const userOwnedOpenai = Object.keys(existingOpenai).length > 0 && !managedOpenai;
  const shouldManage = (!selectedProvider && !userOwnedOpenai)
    || (selectedProvider === OPENAI_VOICE_PROVIDER_ID && managedOpenai);

  // A user-selected provider, including a personal OpenAI configuration, is
  // authoritative. OneClaw only fills an absent selection or refreshes the
  // exact env-backed configuration it previously installed.
  if (!shouldManage) return false;

  const before = JSON.stringify(existingMessages);
  tts.provider = OPENAI_VOICE_PROVIDER_ID;
  providers[OPENAI_VOICE_PROVIDER_ID] = {
    ...existingOpenai,
    apiKey: CLAWROUTERS_API_KEY_REF,
    baseUrl: resolveClawroutersApiBaseUrl(env),
    model: "tts",
    speakerVoice: typeof existingOpenai.speakerVoice === "string"
      && existingOpenai.speakerVoice.trim()
      ? existingOpenai.speakerVoice
      : "coral",
  };
  tts.providers = providers;
  messages.tts = tts;
  if (before === JSON.stringify(messages)) return false;
  cfg.messages = messages;
  return true;
}

function applyClawroutersManagedRealtimePatch(cfg, env) {
  const existingTalk = isObject(cfg.talk) ? cfg.talk : {};
  const talk = { ...existingTalk };
  const existingRealtime = isObject(talk.realtime) ? talk.realtime : {};
  const realtime = { ...existingRealtime };
  const existingProviders = isObject(realtime.providers) ? realtime.providers : {};
  const providers = { ...existingProviders };
  const existingOpenai = isObject(providers[OPENAI_VOICE_PROVIDER_ID])
    ? providers[OPENAI_VOICE_PROVIDER_ID]
    : {};
  const managedOpenai = existingOpenai.managedBy === CLAWROUTERS_MANAGED_VOICE_MARKER;
  const selectedProvider = typeof realtime.provider === "string"
    ? realtime.provider.trim()
    : "";
  const legacyManagedProvider = selectedProvider === LEGACY_CLAWROUTERS_VOICE_PROVIDER_ID;
  const selectedManagedOpenai = selectedProvider === OPENAI_VOICE_PROVIDER_ID && managedOpenai;
  const unselectedPersonalOpenai = !selectedProvider
    && Object.keys(existingOpenai).length > 0
    && !managedOpenai;

  if (
    (selectedProvider && !legacyManagedProvider && !selectedManagedOpenai)
    || unselectedPersonalOpenai
  ) {
    return false;
  }

  const legacyConfig = isObject(providers[LEGACY_CLAWROUTERS_VOICE_PROVIDER_ID])
    ? providers[LEGACY_CLAWROUTERS_VOICE_PROVIDER_ID]
    : {};
  const existing = managedOpenai ? existingOpenai : legacyConfig;
  const existingVoice = typeof existing.speakerVoice === "string"
    ? existing.speakerVoice.trim().toLowerCase()
    : "";
  const before = JSON.stringify(existingTalk);
  const desired = {
    ...existing,
    managedBy: CLAWROUTERS_MANAGED_VOICE_MARKER,
    apiKey: CLAWROUTERS_API_KEY_REF,
    baseUrl: resolveClawroutersApiBaseUrl(env),
    model: "realtime",
    speakerVoice: CLAWROUTERS_REALTIME_VOICES.has(existingVoice) ? existingVoice : "coral",
    vadThreshold: typeof existing.vadThreshold === "number" ? existing.vadThreshold : 0.5,
    silenceDurationMs: typeof existing.silenceDurationMs === "number"
      ? existing.silenceDurationMs
      : 700,
    prefixPaddingMs: typeof existing.prefixPaddingMs === "number"
      ? existing.prefixPaddingMs
      : 300,
  };
  delete desired.authProviderId;
  delete desired.transportMode;
  delete desired.rmsThreshold;
  delete desired.speed;
  delete providers[LEGACY_CLAWROUTERS_VOICE_PROVIDER_ID];
  providers[OPENAI_VOICE_PROVIDER_ID] = desired;
  talk.realtime = {
    ...realtime,
    provider: OPENAI_VOICE_PROVIDER_ID,
    model: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
    consultRouting: "provider-direct",
    providers,
  };
  // clawrouters/auto advertises the disabled thinking override for these
  // one-shot consults. A fixed non-zero level can be rejected before tools run.
  talk.consultThinkingLevel = "off";
  talk.consultFastMode = true;
  if (before === JSON.stringify(talk)) return false;
  cfg.talk = talk;
  return true;
}

function removeClawroutersManagedTtsPatch(cfg) {
  if (!isObject(cfg.messages) || !isObject(cfg.messages.tts)) return false;
  const messages = { ...cfg.messages };
  const tts = { ...messages.tts };
  if (!isObject(tts.providers)) return false;
  const providers = { ...tts.providers };
  const openai = isObject(providers[OPENAI_VOICE_PROVIDER_ID])
    ? providers[OPENAI_VOICE_PROVIDER_ID]
    : null;
  if (!openai || !isClawroutersApiKeyRef(openai.apiKey)) return false;

  delete providers[OPENAI_VOICE_PROVIDER_ID];
  if (tts.provider === OPENAI_VOICE_PROVIDER_ID) delete tts.provider;
  if (Object.keys(providers).length > 0) tts.providers = providers;
  else delete tts.providers;
  if (Object.keys(tts).length > 0) messages.tts = tts;
  else delete messages.tts;
  if (Object.keys(messages).length > 0) cfg.messages = messages;
  else delete cfg.messages;
  return true;
}

function removeClawroutersManagedRealtimePatch(cfg) {
  if (!isObject(cfg.talk) || !isObject(cfg.talk.realtime)) return false;
  const talk = { ...cfg.talk };
  const realtime = { ...talk.realtime };
  if (!isObject(realtime.providers)) return false;
  const providers = { ...realtime.providers };
  const openai = isObject(providers[OPENAI_VOICE_PROVIDER_ID])
    ? providers[OPENAI_VOICE_PROVIDER_ID]
    : null;
  if (openai?.managedBy !== CLAWROUTERS_MANAGED_VOICE_MARKER) return false;

  const selectedManagedProvider = realtime.provider === OPENAI_VOICE_PROVIDER_ID;
  delete providers[OPENAI_VOICE_PROVIDER_ID];
  if (Object.keys(providers).length > 0) realtime.providers = providers;
  else delete realtime.providers;
  if (selectedManagedProvider) {
    delete realtime.provider;
    if (realtime.model === "realtime") delete realtime.model;
    if (realtime.transport === "gateway-relay") delete realtime.transport;
    if (realtime.brain === "agent-consult") delete realtime.brain;
    if (realtime.consultRouting === "provider-direct") delete realtime.consultRouting;
  }
  if (Object.keys(realtime).length > 0) talk.realtime = realtime;
  else delete talk.realtime;
  if (talk.consultThinkingLevel === "off") delete talk.consultThinkingLevel;
  if (talk.consultFastMode === true) delete talk.consultFastMode;
  if (Object.keys(talk).length > 0) cfg.talk = talk;
  else delete cfg.talk;
  return true;
}

function applyClawroutersManagedVoicePatch(cfg, env) {
  let changed = false;
  changed = applyClawroutersManagedTtsPatch(cfg, env) || changed;
  changed = applyClawroutersManagedRealtimePatch(cfg, env) || changed;
  return changed;
}

function removeClawroutersManagedVoicePatch(cfg) {
  let changed = false;
  changed = removeClawroutersManagedTtsPatch(cfg) || changed;
  changed = removeClawroutersManagedRealtimePatch(cfg) || changed;
  return changed;
}

function applyOneclawWebSearchPatch(cfg) {
  const plugins = ensureObject(cfg, "plugins");
  const pluginEntries = ensureObject(plugins, "entries");
  const searchPlugin = ensureObject(pluginEntries, ONECLAW_SEARCH_PLUGIN_ID);
  let changed = setJsonValue(searchPlugin, "enabled", true);

  const tools = ensureObject(cfg, "tools");
  const web = ensureObject(tools, "web");
  const search = ensureObject(web, "search");
  const selectedProvider = typeof search.provider === "string"
    ? search.provider.trim()
    : "";

  // Respect an explicitly selected third-party provider. With no selection,
  // choose OneClaw Search while preserving an explicit enabled=false opt-out.
  if (!selectedProvider) {
    changed = setJsonValue(search, "provider", ONECLAW_SEARCH_PROVIDER_ID) || changed;
  }
  if (
    (selectedProvider === "" || selectedProvider === ONECLAW_SEARCH_PROVIDER_ID)
    && search.enabled !== false
  ) {
    changed = setJsonValue(search, "enabled", true) || changed;
  }
  return changed;
}

function applyOneclawChannelPatch(cfg) {
  const plugins = ensureObject(cfg, "plugins");
  const pluginEntries = ensureObject(plugins, "entries");
  const channelPlugin = ensureObject(pluginEntries, ONECLAW_CHANNEL_PLUGIN_ID);
  let changed = setJsonValue(channelPlugin, "enabled", true);

  if (
    Array.isArray(plugins.allow)
    && plugins.allow.length > 0
    && !plugins.allow.includes(ONECLAW_CHANNEL_PLUGIN_ID)
  ) {
    plugins.allow = [...plugins.allow, ONECLAW_CHANNEL_PLUGIN_ID];
    changed = true;
  }
  return changed;
}

function removeRetiredOneclawCollaborationPlugins(cfg) {
  const plugins = cfg.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return false;
  let changed = false;

  if (plugins.entries && typeof plugins.entries === "object" && !Array.isArray(plugins.entries)) {
    for (const pluginId of RETIRED_ONECLAW_COLLABORATION_PLUGIN_IDS) {
      if (!Object.hasOwn(plugins.entries, pluginId)) continue;
      delete plugins.entries[pluginId];
      changed = true;
    }
  }

  if (Array.isArray(plugins.allow)) {
    const nextAllow = plugins.allow.filter(
      (pluginId) => !RETIRED_ONECLAW_COLLABORATION_PLUGIN_IDS.has(pluginId),
    );
    if (nextAllow.length !== plugins.allow.length) {
      plugins.allow = nextAllow;
      changed = true;
    }
  }

  return changed;
}

function applyNativePlanToolPatch(cfg) {
  const tools = ensureObject(cfg, "tools");
  const experimental = ensureObject(tools, "experimental");
  if (experimental.planTool !== undefined) return false;
  experimental.planTool = true;
  return true;
}

function applyWorkboardPatch(cfg) {
  const plugins = ensureObject(cfg, "plugins");
  const pluginEntries = ensureObject(plugins, "entries");
  const workboardPlugin = ensureObject(pluginEntries, WORKBOARD_PLUGIN_ID);
  let changed = false;

  // Enable Workboard by default for both fresh configs and persisted-volume
  // upgrades, while preserving an explicit user opt-out.
  if (workboardPlugin.enabled === undefined) {
    workboardPlugin.enabled = true;
    changed = true;
  }

  if (
    workboardPlugin.enabled !== false
    && Array.isArray(plugins.allow)
    && plugins.allow.length > 0
    && !plugins.allow.includes(WORKBOARD_PLUGIN_ID)
  ) {
    plugins.allow = [...plugins.allow, WORKBOARD_PLUGIN_ID];
    changed = true;
  }

  return changed;
}

function applyOpenclawProviderAgentRuntimePins(cfg) {
  const providers = cfg?.models?.providers;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) {
    return false;
  }

  let changed = false;
  for (const [providerId, runtimeId] of Object.entries(OPENCLAW_PROVIDER_PINNED_AGENT_RUNTIME)) {
    const provider = providers[providerId];
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) continue;
    const existing = provider.agentRuntime;
    if (
      existing
      && typeof existing === "object"
      && !Array.isArray(existing)
      && typeof existing.id === "string"
      && existing.id.trim()
    ) {
      continue;
    }
    provider.agentRuntime = { id: runtimeId };
    changed = true;
  }
  return changed;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function applyRuntimeDefaults(cfg, env = process.env) {
  if (!cfg || typeof cfg !== "object") return false;
  let changed = false;

  const agents = ensureObject(cfg, "agents");
  const defaults = ensureObject(agents, "defaults");
  changed = setJsonValue(defaults, "heartbeat", DEFAULT_HEARTBEAT) || changed;

  // The cloud profile intentionally omits the heavyweight Codex/Gemini CLIs.
  // Keep the bundled coding-agent opt-in there; the full profile retains the
  // previous always-enabled behavior.
  if (env.ONECLAW_RUNTIME_PROFILE?.trim().toLowerCase() !== "cloud") {
    const skills = ensureObject(cfg, "skills");
    const skillEntries = ensureObject(skills, "entries");
    const codingAgent = ensureObject(skillEntries, "coding-agent");
    changed = setJsonValue(codingAgent, "enabled", true) || changed;
  }
  changed = removeRetiredOneclawCollaborationPlugins(cfg) || changed;
  changed = applyOneclawChannelPatch(cfg) || changed;
  changed = applyWorkboardPatch(cfg) || changed;
  changed = applyNativePlanToolPatch(cfg) || changed;
  changed = applyPreinstalledSkillsDefaults(cfg, env) || changed;

  const hasKey = hasClawroutersKey(env);
  const provider = cfg?.models?.providers?.clawrouters;
  const memorySearch = cfg?.agents?.defaults?.memorySearch;
  const usesClawroutersMemory = memorySearch?.provider === "clawrouters";

  if (hasKey) {
    const models = ensureObject(cfg, "models");
    if (!models.mode) {
      models.mode = "merge";
      changed = true;
    }
    const providers = ensureObject(models, "providers");
    changed = setJsonValue(providers, "clawrouters", buildClawroutersProviderShape(env)) || changed;
  } else if (env.CLAWROUTERS_BASE_URL?.trim() && provider) {
    const nextBaseUrl = resolveClawroutersApiBaseUrl(env);
    if (provider.baseUrl !== nextBaseUrl) {
      provider.baseUrl = nextBaseUrl;
      changed = true;
    }
  }
  changed = applyOpenclawProviderAgentRuntimePins(cfg) || changed;

  if (hasKey || usesClawroutersMemory) {
    changed = applyClawroutersMemorySearchPatch(defaults, env) || changed;
  }
  if (hasKey) {
    changed = applyOneclawWebSearchPatch(cfg) || changed;
    changed = applyClawroutersManagedVoicePatch(cfg, env) || changed;
  } else {
    // Persisted Railway volumes outlive environment changes. Remove only the
    // exact OneClaw-managed voice references so a deleted child key cannot
    // leave Gateway catalog or startup resolution stuck on a missing secret.
    changed = removeClawroutersManagedVoicePatch(cfg) || changed;
  }

  return changed;
}
