import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyRuntimeDefaults,
  generateConfigDirect,
} from "../src/config/generate.js";

test("runtime defaults enable Channel, Workboard, and the native plan tool without provider credentials", () => {
  const cfg = {};

  assert.equal(applyRuntimeDefaults(cfg, {}), true);
  assert.equal(cfg.plugins.entries["oneclaw-channel"].enabled, true);
  assert.equal(cfg.plugins.entries.workboard.enabled, true);
  assert.equal(cfg.tools.experimental.planTool, true);
});

test("runtime defaults preserve an explicit plan-tool opt-out", () => {
  const cfg = { tools: { experimental: { planTool: false } } };

  applyRuntimeDefaults(cfg, {});

  assert.equal(cfg.tools.experimental.planTool, false);
});

test("runtime defaults remove retired collaboration plugin registrations", () => {
  const cfg = {
    plugins: {
      allow: ["clawrouters", "oneclaw-workflows", "oneclaw-employee-catalog"],
      entries: {
        "oneclaw-workflows": { enabled: true },
        "oneclaw-employee-catalog": { enabled: true },
        custom: { enabled: true },
      },
    },
  };

  applyRuntimeDefaults(cfg, {});

  assert.equal(cfg.plugins.entries["oneclaw-workflows"], undefined);
  assert.equal(cfg.plugins.entries["oneclaw-employee-catalog"], undefined);
  assert.deepEqual(cfg.plugins.entries.custom, { enabled: true });
  assert.deepEqual(cfg.plugins.allow, ["clawrouters", "oneclaw-channel", "workboard"]);
});

test("runtime defaults preserve an explicit Workboard opt-out", () => {
  const cfg = { plugins: { entries: { workboard: { enabled: false } } } };

  applyRuntimeDefaults(cfg, {});

  assert.equal(cfg.plugins.entries.workboard.enabled, false);
});

test("runtime defaults extend only an already-restrictive plugin allowlist", () => {
  const restrictive = { plugins: { allow: ["clawrouters"] } };
  const nonRestrictive = { plugins: { allow: [] } };

  applyRuntimeDefaults(restrictive, {});
  applyRuntimeDefaults(nonRestrictive, {});

  assert.deepEqual(restrictive.plugins.allow, [
    "clawrouters",
    "oneclaw-channel",
    "workboard",
  ]);
  assert.deepEqual(nonRestrictive.plugins.allow, []);
});

test("fresh config enables bundled OneClaw Channel and native orchestration without ordinary install records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-native-orchestration-config-"));
  const pluginsDir = path.join(root, "plugins");
  const installedChannel = path.join(
    pluginsDir,
    "node_modules",
    "@oneclaw-plugins",
    "channel",
  );
  fs.mkdirSync(installedChannel, { recursive: true });
  const configPath = path.join(root, "state", "openclaw.json");

  const cfg = generateConfigDirect({
    configPath,
    workspaceDir: path.join(root, "workspace"),
    gatewayToken: "gateway-token",
    env: { OPENCLAW_PLUGINS_DIR: pluginsDir },
  });

  assert.equal(cfg.plugins.load, undefined);
  assert.equal(cfg.plugins.installs?.["oneclaw-workflows"], undefined);
  assert.equal(cfg.plugins.installs?.["oneclaw-employee-catalog"], undefined);
  assert.equal(cfg.plugins.installs?.["oneclaw-channel"], undefined);
  assert.equal(cfg.plugins.entries["oneclaw-workflows"], undefined);
  assert.equal(cfg.plugins.entries["oneclaw-employee-catalog"], undefined);
  assert.equal(cfg.plugins.entries["oneclaw-channel"].enabled, true);
  assert.equal(cfg.plugins.entries.workboard.enabled, true);
  assert.equal(cfg.tools.experimental.planTool, true);
});
