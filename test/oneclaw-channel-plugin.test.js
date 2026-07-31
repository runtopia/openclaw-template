import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildPreinstalledPluginInstallRecords,
  resolvePreinstalledPluginPaths,
} from "../src/config/plugins.js";
import { buildOneclawChannelStatus } from "../src/integration/oneclaw.js";

test("embedded OneClaw package checksums match the release payloads", () => {
  const packageDir = fileURLToPath(
    new URL("../resources/oneclaw-packages/", import.meta.url),
  );
  const checksumLines = fs
    .readFileSync(path.join(packageDir, "checksums.sha256"), "utf8")
    .trim()
    .split("\n");

  assert.deepEqual(
    checksumLines.map((line) => line.trim().split(/\s+/).at(-1)),
    ["oneclaw-runtime-events-0.1.0.tgz", "oneclaw-channel-0.1.0.tgz"],
  );
  for (const line of checksumLines) {
    const [expected, fileName] = line.trim().split(/\s+/);
    const actual = createHash("sha256")
      .update(fs.readFileSync(path.join(packageDir, fileName)))
      .digest("hex");
    assert.equal(actual, expected, `${fileName} checksum`);
  }
});

test("preinstalled OneClaw Channel is discovered and recorded with its package identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-channel-plugin-"));
  try {
    const pluginsDir = path.join(root, "plugins");
    const packageDir = path.join(pluginsDir, "node_modules", "@oneclaw", "channel");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@oneclaw/channel", version: "0.1.0" }),
    );
    const env = { OPENCLAW_PLUGINS_DIR: pluginsDir };

    assert.deepEqual(resolvePreinstalledPluginPaths(env), [packageDir]);
    assert.deepEqual(buildPreinstalledPluginInstallRecords(env)["oneclaw-channel"], {
      source: "npm",
      spec: "@oneclaw/channel",
      resolvedName: "@oneclaw/channel",
      resolvedSpec: "@oneclaw/channel@0.1.0",
      version: "0.1.0",
      resolvedVersion: "0.1.0",
      installPath: packageDir,
      installedAt: "1970-01-01T00:00:00.000Z",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("heartbeat Channel summary reports configuration and live plugin state without secrets", () => {
  const summary = buildOneclawChannelStatus({
    apiUrl: "https://api.oneclaw.example/api/v1",
    channelEnabled: "1",
    gatewayReady: true,
    gatewayStarting: false,
    hasSecret: true,
    runtimeId: "runtime_123",
    pluginSnapshot: {
      configured: true,
      running: true,
      connected: true,
      statusState: "connected",
      lastError: "must not be copied",
    },
  });

  assert.deepEqual(summary, {
    enabled: true,
    configured: true,
    gateway_ready: true,
    running: true,
    connected: true,
    state: "connected",
  });
  assert.doesNotMatch(JSON.stringify(summary), /secret|lastError/);
});

test("heartbeat Channel summary distinguishes unconfigured and Gateway-unavailable states", () => {
  assert.equal(buildOneclawChannelStatus({
    apiUrl: "",
    channelEnabled: "1",
    gatewayReady: false,
    gatewayStarting: false,
    hasSecret: true,
    runtimeId: "runtime_123",
  }).state, "missing_api_url");
  assert.equal(buildOneclawChannelStatus({
    apiUrl: "https://api.oneclaw.example/api/v1",
    channelEnabled: "1",
    gatewayReady: false,
    gatewayStarting: true,
    hasSecret: true,
    runtimeId: "runtime_123",
  }).state, "gateway_starting");
});
