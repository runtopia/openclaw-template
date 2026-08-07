import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyPreinstalledPluginInstallRecords,
  buildPreinstalledPluginInstallRecords,
  resolvePreinstalledPluginPaths,
} from "../src/config/plugins.js";
import { buildOneclawChannelStatus } from "../src/integration/oneclaw.js";

test("bundled OneClaw Channel is excluded from ordinary discovery and install records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-channel-plugin-"));
  try {
    const pluginsDir = path.join(root, "plugins");
    const packageDir = path.join(pluginsDir, "node_modules", "@oneclaw-plugins", "channel");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@oneclaw-plugins/channel", version: "0.1.13" }),
    );
    const env = { OPENCLAW_PLUGINS_DIR: pluginsDir };

    assert.deepEqual(resolvePreinstalledPluginPaths(env), []);
    assert.equal(buildPreinstalledPluginInstallRecords(env)["oneclaw-channel"], undefined);

    const cfg = {
      plugins: {
        installs: {
          "oneclaw-channel": { installPath: packageDir, version: "0.1.13" },
        },
      },
    };
    assert.equal(applyPreinstalledPluginInstallRecords(cfg, env), true);
    assert.equal(cfg.plugins.installs["oneclaw-channel"], undefined);
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
