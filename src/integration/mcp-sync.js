import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { patchConfig } from "../config/edit.js";

export const ONECLAW_COMPOSIO_MCP_SERVER_ID = "oneclaw-composio-main";
const MANAGED_TOOL_PATTERN = `${ONECLAW_COMPOSIO_MCP_SERVER_ID}__*`;
const SNAPSHOT_SCHEMA_VERSION = 1;
const MAX_TOOLS = 128;
const RUNTIME_MCP_PROXY_PATH = "runtime/integrations/mcp";
const SIDECAR_MCP_PROXY_PATH = "/internal/mcp/composio";

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function uniqueStrings(values, maximum = MAX_TOOLS) {
  if (!Array.isArray(values) || values.length > maximum) throw new Error("invalid MCP string list");
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function normalizeSidecarURL(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw new Error("invalid Sidecar MCP proxy URL"); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || !new Set(["127.0.0.1", "::1", "localhost"]).has(host) || parsed.pathname !== SIDECAR_MCP_PROXY_PATH) {
    throw new Error("invalid Sidecar MCP proxy URL");
  }
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function normalizeServer(raw, connectionUrl) {
  const server = asObject(raw);
  const keys = Object.keys(server);
  const allowed = new Set([
    "id", "target_agent_ids", "enabled", "transport", "url", "connection_timeout_ms",
    "request_timeout_ms", "supports_parallel_tool_calls", "tool_filter",
  ]);
  if (keys.some((key) => !allowed.has(key))) throw new Error("unsupported MCP server field");
  if (server.id !== ONECLAW_COMPOSIO_MCP_SERVER_ID) throw new Error("unsupported MCP server id");
  if (server.transport !== "streamable-http") throw new Error("unsupported MCP transport");
  const url = String(server.url || "").trim();
  if (url !== RUNTIME_MCP_PROXY_PATH) throw new Error("unsupported MCP proxy path");
  const targets = uniqueStrings(server.target_agent_ids, 8);
  if (targets.length !== 1 || targets[0] !== "main") throw new Error("unsupported MCP target Agent");
  const connectionTimeoutMs = Number(server.connection_timeout_ms ?? 5000);
  const requestTimeoutMs = Number(server.request_timeout_ms ?? 30000);
  if (!Number.isInteger(connectionTimeoutMs) || connectionTimeoutMs < 1000 || connectionTimeoutMs > 30000) {
    throw new Error("invalid MCP connection timeout");
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 120000) {
    throw new Error("invalid MCP request timeout");
  }
  const filter = asObject(server.tool_filter);
  if (Object.keys(filter).some((key) => key !== "include")) throw new Error("unsupported MCP tool filter");
  const include = uniqueStrings(filter.include);
  if (include.some((tool) => tool.length > 128 || !/^[A-Za-z0-9_.:-]+$/u.test(tool))) {
    throw new Error("invalid MCP tool name");
  }
  return {
    id: ONECLAW_COMPOSIO_MCP_SERVER_ID,
    targetAgentIds: targets,
    protocol: {
      id: ONECLAW_COMPOSIO_MCP_SERVER_ID,
      target_agent_ids: targets,
      enabled: server.enabled !== false,
      transport: "streamable-http",
      url,
      connection_timeout_ms: connectionTimeoutMs,
      request_timeout_ms: requestTimeoutMs,
      supports_parallel_tool_calls: server.supports_parallel_tool_calls === true,
      tool_filter: { include },
    },
    config: {
      enabled: server.enabled !== false,
      url: normalizeSidecarURL(connectionUrl),
      transport: "streamable-http",
      connectionTimeoutMs,
      requestTimeoutMs,
      supportsParallelToolCalls: server.supports_parallel_tool_calls === true,
      ...(include.length ? { toolFilter: { include } } : {}),
    },
  };
}

export function normalizeMcpSnapshot(raw, { connectionUrl } = {}) {
  const snapshot = asObject(raw);
  const keys = Object.keys(snapshot);
  const allowed = new Set(["schema_version", "revision", "digest", "servers"]);
  if (keys.some((key) => !allowed.has(key))) throw new Error("unsupported MCP snapshot field");
  if (snapshot.schema_version !== SNAPSHOT_SCHEMA_VERSION) throw new Error("unsupported MCP snapshot schema");
  const revision = Number(snapshot.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("invalid MCP snapshot revision");
  if (!Array.isArray(snapshot.servers) || snapshot.servers.length > 1) throw new Error("invalid MCP server list");
  const servers = snapshot.servers.map((server) => normalizeServer(server, connectionUrl));
  const digest = String(snapshot.digest || "").trim();
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("invalid MCP snapshot digest");
  const expectedDigest = `sha256:${crypto.createHash("sha256").update(JSON.stringify(servers.map((server) => server.protocol))).digest("hex")}`;
  if (digest !== expectedDigest) throw new Error("MCP snapshot digest mismatch");
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, revision, digest, servers };
}

export function managedMcpDigest(servers) {
  const canonical = servers.map((server) => ({ id: server.id, ...server.config }));
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

export function readMcpSyncState(statePath) {
  try {
    return asObject(JSON.parse(fs.readFileSync(statePath, "utf8")));
  } catch {
    return {};
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, statePath);
    fs.chmodSync(statePath, 0o600);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function mergeDeny(agent, shouldDeny, previouslyManaged) {
  const hasTools = agent.tools && typeof agent.tools === "object" && !Array.isArray(agent.tools);
  if (!hasTools && !shouldDeny) return false;
  if (!hasTools) agent.tools = {};
  const existing = Array.isArray(agent.tools.deny) ? agent.tools.deny.filter((value) => typeof value === "string") : [];
  const hadPattern = existing.includes(MANAGED_TOOL_PATTERN);
  if (shouldDeny && !hadPattern) {
    agent.tools.deny = [...existing, MANAGED_TOOL_PATTERN];
    return true;
  }
  if (!shouldDeny && previouslyManaged && hadPattern) {
    const next = existing.filter((value) => value !== MANAGED_TOOL_PATTERN);
    if (next.length) agent.tools.deny = next;
    else delete agent.tools.deny;
  }
  return previouslyManaged && hadPattern;
}

export function applyMcpSnapshot({ configPath, connectionHeaders, connectionUrl, statePath, snapshot: rawSnapshot, now = () => new Date() }) {
  const snapshot = normalizeMcpSnapshot(rawSnapshot, { connectionUrl });
  const previous = readMcpSyncState(statePath);
  if (Number.isSafeInteger(previous.revision) && previous.revision > snapshot.revision) {
    return { ...previous, status: "unchanged" };
  }
  const previousManagedDenies = asObject(previous.managed_agent_denies);
  const desired = snapshot.servers[0];
  const managedAgentDenies = {};
  patchConfig(configPath, (config) => {
    if (!config.mcp || typeof config.mcp !== "object" || Array.isArray(config.mcp)) config.mcp = {};
    if (!config.mcp.servers || typeof config.mcp.servers !== "object" || Array.isArray(config.mcp.servers)) {
      config.mcp.servers = {};
    }
    delete config.mcp.servers[ONECLAW_COMPOSIO_MCP_SERVER_ID];
    if (desired) {
      const sidecarToken = String(connectionHeaders?.["X-OneClaw-Sidecar-MCP-Token"] || "").trim();
      if (!/^[a-f0-9]{64}$/u.test(sidecarToken)) throw new Error("invalid Sidecar MCP token");
      config.mcp.servers[desired.id] = {
        ...desired.config,
        headers: { "X-OneClaw-Sidecar-MCP-Token": sidecarToken },
      };
    }
    if (Object.keys(config.mcp.servers).length === 0) delete config.mcp.servers;
    if (Object.keys(config.mcp).length === 0) delete config.mcp;

    const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
    for (const agent of agents) {
      const agentId = String(agent?.id || agent?.agentId || "").trim();
      if (!agentId) continue;
      const shouldDeny = Boolean(desired && !desired.targetAgentIds.includes(agentId));
      const managed = mergeDeny(agent, shouldDeny, previousManagedDenies[agentId] === true);
      if (shouldDeny && managed) managedAgentDenies[agentId] = true;
    }
  });
  fs.chmodSync(configPath, 0o600);
  const state = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    revision: snapshot.revision,
    digest: snapshot.digest,
    managed_server_ids: desired ? [desired.id] : [],
    managed_agent_denies: managedAgentDenies,
    server_count: snapshot.servers.length,
    status: "applied",
    applied_at: now().toISOString(),
  };
  writeState(statePath, state);
  return state;
}

export function applyManagedMcpIsolationToAgent(agent, statePath) {
  const state = readMcpSyncState(statePath);
  if (!Array.isArray(state.managed_server_ids) || !state.managed_server_ids.includes(ONECLAW_COMPOSIO_MCP_SERVER_ID)) return false;
  const agentId = String(agent?.id || agent?.agentId || "").trim();
  if (!agentId || agentId === "main") return false;
  const managedAgentDenies = asObject(state.managed_agent_denies);
  const managed = mergeDeny(agent, true, managedAgentDenies[agentId] === true);
  if (managed && managedAgentDenies[agentId] !== true) {
    writeState(statePath, {
      ...state,
      managed_agent_denies: { ...managedAgentDenies, [agentId]: true },
    });
  }
  return managed;
}
