import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";
import { createRuntimeMcpSidecarProxy, isLoopbackAddress } from "../src/integration/mcp-proxy.js";

test("Sidecar MCP proxy injects Runtime auth and streams the protocol response", async (t) => {
  let captured;
  const app = express();
  app.all("/internal/mcp/composio", createRuntimeMcpSidecarProxy({
    apiUrl: "https://oneclaw.example.com/api/v1",
    instanceId: "runtime-1",
    instanceSecret: "runtime-secret",
    sidecarToken: "c".repeat(64),
    async fetchImpl(url, options) {
      captured = { url, options };
      return new Response('{"jsonrpc":"2.0","result":{"tools":[]}}', {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "upstream-session" },
      });
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const unauthorized = await fetch(`http://127.0.0.1:${address.port}/internal/mcp/composio`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: '{"jsonrpc":"2.0","method":"tools/list"}',
  });
  assert.equal(unauthorized.status, 401);
  assert.equal(captured, undefined);
  const response = await fetch(`http://127.0.0.1:${address.port}/internal/mcp/composio`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-session-id": "local-session",
      "x-oneclaw-sidecar-mcp-token": "c".repeat(64),
    },
    body: '{"jsonrpc":"2.0","method":"tools/list"}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("mcp-session-id"), "upstream-session");
  assert.equal(captured.url, "https://oneclaw.example.com/api/v1/runtime/integrations/mcp");
  assert.equal(captured.options.headers.Authorization, "Bearer runtime-secret");
  assert.equal(captured.options.headers["X-OneClaw-Instance-ID"], "runtime-1");
  assert.equal(captured.options.headers["mcp-session-id"], "local-session");
  assert.equal(Buffer.from(captured.options.body).toString(), '{"jsonrpc":"2.0","method":"tools/list"}');
  assert.deepEqual(await response.json(), { jsonrpc: "2.0", result: { tools: [] } });
});

test("Sidecar MCP proxy accepts only loopback socket addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.0.0.8"), false);
});
