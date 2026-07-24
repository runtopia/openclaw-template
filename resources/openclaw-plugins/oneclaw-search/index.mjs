import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveProviderAuthProfileApiKey } from "openclaw/plugin-sdk/provider-auth";
import {
  readResponseText,
  resolveSiteName,
  withSelfHostedWebSearchEndpoint,
  wrapWebContent,
} from "openclaw/plugin-sdk/provider-web-search";

const PLUGIN_ID = "oneclaw-search";
const PROVIDER_ID = "oneclaw-search";
const DEFAULT_AUTH_PROVIDER_ID = "clawrouters";
const DEFAULT_BASE_URL = "https://www.clawrouters.com/api/v1";
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_RESULT_COUNT = 5;
const MAX_RESULT_COUNT = 10;

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "Search query string.",
    },
    count: {
      type: "integer",
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_RESULT_COUNT,
    },
    categories: {
      type: "string",
      description: "Optional search category, for example general or news.",
    },
    language: {
      type: "string",
      description: "Optional result language code.",
    },
    search_depth: {
      type: "string",
      enum: ["basic", "advanced"],
      description: "Optional OneClaw search depth.",
    },
  },
  required: ["query"],
  additionalProperties: false,
};

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pluginConfig(config) {
  return config?.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
}

function providerConfigId(config) {
  return cleanString(pluginConfig(config).providerConfigId) || DEFAULT_AUTH_PROVIDER_ID;
}

function providerConfig(config) {
  return config?.models?.providers?.[providerConfigId(config)] ?? {};
}

function resolveBaseUrl(config) {
  return (
    cleanString(pluginConfig(config).baseUrl)
    || cleanString(providerConfig(config).baseUrl)
    || DEFAULT_BASE_URL
  ).replace(/\/+$/u, "");
}

function resolveTimeoutMs(config) {
  const value = Number(pluginConfig(config).timeoutMs);
  return Number.isFinite(value) && value >= 1_000
    ? Math.min(value, 120_000)
    : DEFAULT_TIMEOUT_MS;
}

function resolveCount(value) {
  const count = Number(value ?? DEFAULT_RESULT_COUNT);
  if (!Number.isInteger(count) || count < 1 || count > MAX_RESULT_COUNT) {
    throw new Error(`count must be an integer from 1 to ${MAX_RESULT_COUNT}`);
  }
  return count;
}

function resolveEndpoint(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/search`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

async function resolveApiKey(context) {
  const configId = providerConfigId(context.config);
  return cleanString(
    await resolveProviderAuthProfileApiKey({
      provider: configId,
      cfg: context.config,
      agentDir: context.agentDir,
    }),
  ) || cleanString(providerConfig(context.config).apiKey)
    || cleanString(process.env.CLAWROUTERS_API_KEY)
    || cleanString(process.env.CLAWROUTERS_KEY);
}

function normalizeResult(value) {
  if (!value || typeof value !== "object") return null;
  const title = cleanString(value.title);
  const url = cleanString(value.url);
  if (!title || !url) return null;
  const snippet = cleanString(value.snippet) || cleanString(value.content) || "";
  return {
    title: wrapWebContent(title, "web_search"),
    url,
    snippet: snippet ? wrapWebContent(snippet, "web_search") : "",
    siteName: cleanString(value.site_name)
      || cleanString(value.siteName)
      || resolveSiteName(url)
      || undefined,
    ...(typeof value.score === "number" ? { score: value.score } : {}),
    ...(cleanString(value.published) ? { published: cleanString(value.published) } : {}),
  };
}

async function executeSearch(context, args, executionContext) {
  const query = cleanString(args.query);
  if (!query) throw new Error("query is required");

  const apiKey = await resolveApiKey(context);
  if (!apiKey) {
    throw new Error("OneClaw Search requires an active OneClaw credential.");
  }

  const endpoint = resolveEndpoint(resolveBaseUrl(context.config));
  return withSelfHostedWebSearchEndpoint({
    url: endpoint,
    timeoutSeconds: resolveTimeoutMs(context.config) / 1_000,
    signal: executionContext?.signal,
    init: {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-OneClaw-Client-Platform": "cloud",
      },
      body: JSON.stringify({
        query,
        count: resolveCount(args.count),
        ...(cleanString(args.categories) ? { categories: cleanString(args.categories) } : {}),
        ...(cleanString(args.language) ? { language: cleanString(args.language) } : {}),
        ...(cleanString(args.search_depth) ? { search_depth: cleanString(args.search_depth) } : {}),
      }),
    },
  }, async (response) => {
    const body = await readResponseText(response, { maxBytes: 1_000_000 });
    if (body.truncated) {
      throw new Error("OneClaw Search response is too large.");
    }
    const text = body.text;
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error("OneClaw Search returned malformed JSON.");
      }
    }
    if (!response.ok) {
      const message = cleanString(payload?.error?.message)
        || cleanString(payload?.message)
        || `HTTP ${response.status}`;
      throw new Error(`OneClaw Search failed: ${message}`);
    }

    const results = (Array.isArray(payload.results) ? payload.results : [])
      .map(normalizeResult)
      .filter(Boolean);
    const upstreamProvider = cleanString(payload.provider) || "unknown";

    return {
      query,
      provider: PROVIDER_ID,
      upstreamProvider,
      count: results.length,
      tookMs: typeof payload.took_ms === "number"
        ? payload.took_ms
        : typeof payload.tookMs === "number"
          ? payload.tookMs
          : undefined,
      cached: payload.cached === true,
      fallbackReason: cleanString(payload.fallback_reason)
        || cleanString(payload.fallbackReason),
      externalContent: {
        untrusted: true,
        source: "web_search",
        provider: PROVIDER_ID,
        wrapped: true,
      },
      results,
    };
  });
}

function createOneClawSearchProvider() {
  return {
    id: PROVIDER_ID,
    label: "OneClaw Search",
    hint: "Search routed through OneClaw with SearXNG and Tavily fallback",
    onboardingScopes: ["text-inference"],
    requiresCredential: true,
    credentialLabel: "OneClaw credential",
    envVars: ["CLAWROUTERS_API_KEY"],
    authProviderId: DEFAULT_AUTH_PROVIDER_ID,
    placeholder: "Managed by OneClaw",
    signupUrl: "https://www.oneclaw.net",
    docsUrl: "https://www.oneclaw.net",
    autoDetectOrder: 20,
    credentialPath: "models.providers.clawrouters.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: (config) => providerConfig(config).apiKey,
    applySelectionConfig: (config) => {
      config.tools ??= {};
      config.tools.web ??= {};
      config.tools.web.search = {
        ...(config.tools.web.search ?? {}),
        enabled: true,
        provider: PROVIDER_ID,
      };
      return config;
    },
    createTool: (context) => ({
      description: "Search the web through OneClaw. Returns titles, URLs, and snippets.",
      parameters: SEARCH_SCHEMA,
      execute: (args, executionContext) => executeSearch(context, args, executionContext),
    }),
  };
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "OneClaw Search",
  description: "OneClaw routed web-search provider.",
  register(api) {
    api.registerWebSearchProvider(createOneClawSearchProvider());
  },
});

export const testing = {
  normalizeResult,
  resolveCount,
  resolveEndpoint,
};
