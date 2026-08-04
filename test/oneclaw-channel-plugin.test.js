import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPreinstalledPluginInstallRecords,
  resolvePreinstalledPluginPaths,
} from "../src/config/plugins.js";
import { buildOneclawChannelStatus } from "../src/integration/oneclaw.js";

test("preinstalled OneClaw Channel is discovered and recorded with its package identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-channel-plugin-"));
  try {
    const pluginsDir = path.join(root, "plugins");
    const packageDir = path.join(pluginsDir, "node_modules", "@oneclaw-plugins", "channel");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@oneclaw-plugins/channel", version: "0.1.1" }),
    );
    const env = { OPENCLAW_PLUGINS_DIR: pluginsDir };

    assert.deepEqual(resolvePreinstalledPluginPaths(env), [packageDir]);
    assert.deepEqual(buildPreinstalledPluginInstallRecords(env)["oneclaw-channel"], {
      source: "npm",
      spec: "@oneclaw-plugins/channel",
      resolvedName: "@oneclaw-plugins/channel",
      resolvedSpec: "@oneclaw-plugins/channel@0.1.1",
      version: "0.1.1",
      resolvedVersion: "0.1.1",
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
