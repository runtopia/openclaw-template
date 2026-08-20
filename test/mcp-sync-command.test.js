import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOneclawIntegration } from "../src/integration/oneclaw.js";

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; } };
}

test("leased sync_mcp command fetches the authoritative snapshot before acknowledgement", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-mcp-command-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspaceDir = path.join(root, "workspace");
  const stateDir = path.join(root, ".openclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "main" }] } }));
  const servers = [{
    id: "oneclaw-composio-main", target_agent_ids: ["main"], enabled: true,
    transport: "streamable-http", url: "https://backend.composio.dev/tool_router/trs_private/mcp",
    connection_timeout_ms: 5000, request_timeout_ms: 30000, supports_parallel_tool_calls: true,
    tool_filter: { include: ["GMAIL_FETCH_EMAILS"] },
  }];
  const digest = `sha256:${crypto.createHash("sha256").update(JSON.stringify(servers)).digest("hex")}`;
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    calls.push({ target, options });
    if (target.endsWith("/runtime/commands?limit=10")) {
      return response({ commands: [{ id: "sync-1", type: "sync_mcp", status: "leased", payload: { revision: 9, digest } }] });
    }
    if (target.endsWith("/runtime/integrations/mcp-snapshot")) {
      return response({ schema_version: 1, revision: 9, digest, servers });
    }
    if (target.endsWith("/runtime/events")) return response({ accepted: true }, 202);
    if (target.endsWith("/runtime/commands/sync-1/ack")) return response({ acknowledged: true });
    throw new Error(`unexpected fetch: ${target}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const integration = createOneclawIntegration({
    apiUrl: "https://oneclaw.example.com/api/v1",
    instanceId: "runtime-1",
    instanceSecret: "secret-1",
    stateDir,
    workspaceDir,
    isGatewayReady: () => true,
    isGatewayStarting: () => false,
  });
  await integration.pollCommands();

  const config = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
  assert.equal(config.mcp.servers["oneclaw-composio-main"].transport, "streamable-http");
  const snapshotIndex = calls.findIndex((call) => call.target.endsWith("/runtime/integrations/mcp-snapshot"));
  const ackIndex = calls.findIndex((call) => call.target.endsWith("/runtime/commands/sync-1/ack"));
  assert.ok(snapshotIndex >= 0 && ackIndex > snapshotIndex);
  assert.deepEqual(JSON.parse(calls[ackIndex].options.body), { status: "succeeded", retryable: false });
  assert.doesNotMatch(JSON.stringify(calls[0]), /trs_private/u);
});
