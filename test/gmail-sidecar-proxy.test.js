import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import { createRuntimeGmailProxy } from "../src/integration/gmail-proxy.js";

test("Gmail workflow proxy injects Runtime auth and preserves the bounded request", async (t) => {
  let captured;
  const app = express();
  app.post("/internal/integrations/gmail/invoke", createRuntimeGmailProxy({
    apiUrl: "https://oneclaw.example.com/api/v1",
    instanceId: "runtime-1",
    instanceSecret: "runtime-secret",
    async fetchImpl(url, options) {
      captured = { url, options };
      return new Response('{"method":"latest_emails","data":{"messages":[]}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const body = '{"method":"latest_emails","params":{"max_results":5}}';
  const response = await fetch(`http://127.0.0.1:${address.port}/internal/integrations/gmail/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

  assert.equal(response.status, 200);
  assert.equal(captured.url, "https://oneclaw.example.com/api/v1/runtime/integrations/gmail/invoke");
  assert.equal(captured.options.headers.Authorization, "Bearer runtime-secret");
  assert.equal(captured.options.headers["X-OneClaw-Instance-ID"], "runtime-1");
  assert.equal(Buffer.from(captured.options.body).toString(), body);
  assert.deepEqual(await response.json(), { method: "latest_emails", data: { messages: [] } });
});

test("Gmail workflow proxy is loopback-only", async () => {
  const handler = createRuntimeGmailProxy({
    apiUrl: "https://oneclaw.example.com/api/v1",
    instanceId: "runtime-1",
    instanceSecret: "runtime-secret",
  });
  let status;
  let body;
  await handler(
    { socket: { remoteAddress: "10.0.0.8" } },
    {
      status(value) { status = value; return this; },
      json(value) { body = value; },
    },
  );
  assert.equal(status, 403);
  assert.deepEqual(body, { error: "loopback access required" });
});
