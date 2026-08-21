import assert from "node:assert/strict";
import test from "node:test";

import express from "express";

import { mountAssistant } from "../src/repair/assistant.js";

test("repair assistant sends the cloud User-Agent to its model backend", async (t) => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  mountAssistant(router, {
    requireSetupAuth: (_req, _res, next) => next(),
    instanceSecret: "",
    runCmd: async () => ({ code: 0, output: "" }),
    clawArgs: (args) => args,
    OPENCLAW_NODE: "node",
    restartGateway: async () => ({}),
    configFilePath: () => "/tmp/not-used.json",
    gatewayManager: {
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      getRecentLogs: () => [],
    },
    getRepairAiKey: () => ({
      api: "openai-chat-completions",
      apiKey: "test-key",
      baseUrl: "https://model.example.test/api/v1",
      model: "auto",
      providerName: "test",
    }),
    gatewayRpc: null,
  });
  app.use("/repair", router);

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const originalFetch = globalThis.fetch;
  const initialImageVersion = process.env.IMAGE_VERSION;
  const initialUserAgent = process.env.ONECLAW_USER_AGENT;
  process.env.IMAGE_VERSION = "3.0.1";
  delete process.env.ONECLAW_USER_AGENT;
  let outboundHeaders;
  globalThis.fetch = async (_url, opts) => {
    outboundHeaders = opts.headers;
    return {
      ok: true,
      async json() {
        return {
          choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        };
      },
    };
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (initialImageVersion === undefined) delete process.env.IMAGE_VERSION;
    else process.env.IMAGE_VERSION = initialImageVersion;
    if (initialUserAgent === undefined) delete process.env.ONECLAW_USER_AGENT;
    else process.env.ONECLAW_USER_AGENT = initialUserAgent;
  });

  const address = server.address();
  const response = await originalFetch(`http://127.0.0.1:${address.port}/repair/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "status" }] }),
  });
  assert.equal(response.status, 200);
  assert.equal(outboundHeaders["User-Agent"], "OneClaw-Cloud/3.0.1");
  assert.equal(outboundHeaders.Authorization, "Bearer test-key");
});
