import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyMcpSnapshot,
  ONECLAW_COMPOSIO_MCP_SERVER_ID,
  readMcpSyncState,
} from "../src/integration/mcp-sync.js";

function digest(servers) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(servers)).digest("hex")}`;
}

function snapshot(revision = 1, servers = [server()]) {
  return { schema_version: 1, revision, digest: digest(servers), servers };
}

function server(overrides = {}) {
  return {
    id: ONECLAW_COMPOSIO_MCP_SERVER_ID,
    target_agent_ids: ["main"],
    enabled: true,
    transport: "streamable-http",
    url: "https://backend.composio.dev/tool_router/trs_secret_value/mcp",
    connection_timeout_ms: 5000,
    request_timeout_ms: 30000,
    supports_parallel_tool_calls: true,
    tool_filter: { include: ["GMAIL_FETCH_EMAILS"] },
    ...overrides,
  };
}

function fixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-mcp-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "openclaw.json");
  const statePath = path.join(root, "oneclaw-mcp-state.json");
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, statePath };
}

test("MCP snapshot preserves user servers and isolates non-target Agents", (t) => {
  const paths = fixture(t, {
    mcp: { servers: { local: { command: "local-server" } } },
    agents: { list: [{ id: "main" }, { id: "worker", tools: { deny: ["dangerous"] } }] },
  });
  const state = applyMcpSnapshot({ ...paths, snapshot: snapshot(4) });
  const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8"));
  assert.deepEqual(config.mcp.servers.local, { command: "local-server" });
  assert.equal(config.mcp.servers[ONECLAW_COMPOSIO_MCP_SERVER_ID].transport, "streamable-http");
  assert.equal(config.agents.list[0].tools, undefined);
  assert.deepEqual(config.agents.list[1].tools.deny, ["dangerous", `${ONECLAW_COMPOSIO_MCP_SERVER_ID}__*`]);
  assert.equal(state.managed_agent_denies.worker, true);
  assert.equal(fs.statSync(paths.configPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.statePath).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(paths.statePath, "utf8"), /trs_secret_value/u);
});

test("empty MCP snapshot removes only OneClaw-owned config and deny entries", (t) => {
  const paths = fixture(t, {
    mcp: { servers: { local: { command: "local-server" } } },
    agents: { list: [{ id: "main" }, { id: "worker" }] },
  });
  applyMcpSnapshot({ ...paths, snapshot: snapshot(4) });
  const empty = snapshot(5, []);
  applyMcpSnapshot({ ...paths, snapshot: empty });
  const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8"));
  assert.deepEqual(config.mcp.servers, { local: { command: "local-server" } });
  assert.equal(config.agents.list[1].tools?.deny, undefined);
  assert.deepEqual(readMcpSyncState(paths.statePath).managed_server_ids, []);
});

test("pre-existing matching deny entry remains user-owned", (t) => {
  const pattern = `${ONECLAW_COMPOSIO_MCP_SERVER_ID}__*`;
  const paths = fixture(t, { agents: { list: [{ id: "main" }, { id: "worker", tools: { deny: [pattern] } }] } });
  applyMcpSnapshot({ ...paths, snapshot: snapshot(2) });
  applyMcpSnapshot({ ...paths, snapshot: snapshot(3, []) });
  const config = JSON.parse(fs.readFileSync(paths.configPath, "utf8"));
  assert.deepEqual(config.agents.list[1].tools.deny, [pattern]);
});

test("invalid or tampered snapshots do not modify config", (t) => {
  const paths = fixture(t, { agents: { list: [{ id: "main" }] } });
  const previous = fs.readFileSync(paths.configPath, "utf8");
  const invalidHostServers = [server({ url: "https://127.0.0.1/mcp" })];
  assert.throws(() => applyMcpSnapshot({ ...paths, snapshot: snapshot(1, invalidHostServers) }), /unsupported MCP URL/u);
  const tampered = snapshot(1);
  tampered.digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => applyMcpSnapshot({ ...paths, snapshot: tampered }), /digest mismatch/u);
  assert.equal(fs.readFileSync(paths.configPath, "utf8"), previous);
});

test("older snapshot revision cannot roll runtime config back", (t) => {
  const paths = fixture(t, { agents: { list: [{ id: "main" }] } });
  applyMcpSnapshot({ ...paths, snapshot: snapshot(8) });
  const previous = fs.readFileSync(paths.configPath, "utf8");
  const result = applyMcpSnapshot({ ...paths, snapshot: snapshot(7, []) });
  assert.equal(result.status, "unchanged");
  assert.equal(fs.readFileSync(paths.configPath, "utf8"), previous);
});
