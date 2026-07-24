// Runtime defaults applied to an existing openclaw.json in memory.
// Extracted from generate.js so callers that only need patching don't
// pull in the full config-generation machinery.
//
// generate.js imports and re-exports applyRuntimeDefaults (and the two
// shared helpers below) so the public API of generate.js is unchanged.

const DEFAULT_HEARTBEAT = { every: "2h", target: "last" };
const CLAWROUTERS_API_KEY_REF = { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" };
const CLAWROUTERS_EMBEDDING_MODEL = "auto";
const ONECLAW_SEARCH_PLUGIN_ID = "oneclaw-search";
const ONECLAW_SEARCH_PROVIDER_ID = "oneclaw-search";

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

// ── Public API ────────────────────────────────────────────────────────────────

export function applyRuntimeDefaults(cfg, env = process.env) {
  if (!cfg || typeof cfg !== "object") return false;
  let changed = false;

  const agents = ensureObject(cfg, "agents");
  const defaults = ensureObject(agents, "defaults");
  changed = setJsonValue(defaults, "heartbeat", DEFAULT_HEARTBEAT) || changed;

  const skills = ensureObject(cfg, "skills");
  const skillEntries = ensureObject(skills, "entries");
  const codingAgent = ensureObject(skillEntries, "coding-agent");
  changed = setJsonValue(codingAgent, "enabled", true) || changed;

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

  if (hasKey || usesClawroutersMemory) {
    changed = applyClawroutersMemorySearchPatch(defaults, env) || changed;
  }
  if (hasKey) {
    changed = applyOneclawWebSearchPatch(cfg) || changed;
  }

  return changed;
}
