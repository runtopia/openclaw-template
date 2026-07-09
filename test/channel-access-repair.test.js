import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import { createRepairRouter } from "../src/repair/router.js";

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function writePairingSdkStub(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-pairing-sdk-"));
  const file = path.join(dir, "conversation-runtime.js");
  fs.writeFileSync(file, source, "utf8");
  return file;
}

test("repair channel access endpoints use pairing store without spawning CLI", async (t) => {
  const sdkPath = writePairingSdkStub(`
    export async function listChannelPairingRequests(channel) {
      return [{ code: "LYMSQ59X", id: "8377439533", createdAt: "2026-07-09T09:41:00Z" }];
    }
    export async function approveChannelPairingCode(params) {
      globalThis.__repairApprovals ||= [];
      globalThis.__repairApprovals.push(params);
      return { id: "8377439533", entry: { code: params.code, id: "8377439533", createdAt: "2026-07-09T09:41:00Z" } };
    }
  `);
  const previousSdkPath = process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE;
  process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE = sdkPath;
  globalThis.__repairApprovals = [];
  let runCmdCalls = 0;
  t.after(() => {
    if (previousSdkPath === undefined) delete process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE;
    else process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE = previousSdkPath;
  });

  const app = express();
  app.use(express.json());
  app.use("/repair", createRepairRouter({
    requireSetupAuth: (_req, _res, next) => next(),
    runCmd: async () => {
      runCmdCalls += 1;
      return { code: 0, output: "" };
    },
    clawArgs: () => ["/usr/local/lib/node_modules/openclaw/dist/entry.js"],
    OPENCLAW_NODE: "node",
    restartGateway: async () => ({ ok: true }),
    configFilePath: () => "/tmp/missing-openclaw.json",
    stateDir: "/tmp",
    gatewayManager: {
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      ensureGatewayRunning: async () => {},
      getRecentLogs: () => [],
    },
    getRepairAiKey: () => null,
  }));

  const server = await listen(app);
  t.after(() => server.close());
  const { port } = server.address();

  const listRes = await fetch(`http://127.0.0.1:${port}/repair/channel-access-requests?channel=telegram`);
  const listBody = await listRes.json();
  assert.equal(listRes.status, 200);
  assert.equal(listBody.requests.length, 1);
  assert.equal(listBody.requests[0].code, "LYMSQ59X");

  const approveRes = await fetch(`http://127.0.0.1:${port}/repair/channel-access-requests/LYMSQ59X/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel: "telegram" }),
  });
  const approveBody = await approveRes.json();
  assert.equal(approveRes.status, 200);
  assert.equal(approveBody.ok, true);
  assert.equal(globalThis.__repairApprovals.length, 1);
  assert.equal(runCmdCalls, 0);
});
