import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyRuntimeDefaults,
  generateConfigDirect,
} from "../src/config/generate.js";

test("runtime defaults enable Durable Work, OneClaw Channel, Workboard, and the native plan tool without provider credentials", () => {
  const cfg = {};

  assert.equal(applyRuntimeDefaults(cfg, {}), true);
  assert.equal(cfg.plugins.entries["oneclaw-workflows"].enabled, true);
  assert.equal(
    cfg.plugins.entries["oneclaw-workflows"].hooks.allowConversationAccess,
    true,
  );
  assert.equal(cfg.plugins.entries["oneclaw-channel"].enabled, true);
  assert.equal(cfg.plugins.entries.workboard.enabled, true);
  assert.equal(cfg.tools.experimental.planTool, true);
});

test("runtime defaults preserve an explicit plan-tool opt-out", () => {
  const cfg = { tools: { experimental: { planTool: false } } };

  applyRuntimeDefaults(cfg, {});

  assert.equal(cfg.tools.experimental.planTool, false);
  assert.equal(cfg.plugins.entries["oneclaw-workflows"].enabled, true);
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
    "oneclaw-workflows",
    "oneclaw-channel",
    "workboard",
  ]);
  assert.deepEqual(nonRestrictive.plugins.allow, []);
});

test("fresh config loads and enables the preinstalled Durable Work and Channel packages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-workflows-config-"));
  const pluginsDir = path.join(root, "plugins");
  const installedPlugin = path.join(
    pluginsDir,
    "node_modules",
    "@oneclaw",
    "durable-work",
  );
  const installedChannel = path.join(
    pluginsDir,
    "node_modules",
    "@oneclaw",
    "channel",
  );
  fs.mkdirSync(installedPlugin, { recursive: true });
  fs.mkdirSync(installedChannel, { recursive: true });
  const configPath = path.join(root, "state", "openclaw.json");

  const cfg = generateConfigDirect({
    configPath,
    workspaceDir: path.join(root, "workspace"),
    gatewayToken: "gateway-token",
    env: { OPENCLAW_PLUGINS_DIR: pluginsDir },
  });

  assert.deepEqual(cfg.plugins.load.paths, [installedPlugin, installedChannel]);
  assert.equal(cfg.plugins.entries["oneclaw-workflows"].enabled, true);
  assert.equal(
    cfg.plugins.entries["oneclaw-workflows"].hooks.allowConversationAccess,
    true,
  );
  assert.equal(cfg.plugins.entries["oneclaw-channel"].enabled, true);
  assert.equal(cfg.plugins.entries.workboard.enabled, true);
  assert.equal(cfg.tools.experimental.planTool, true);
});
