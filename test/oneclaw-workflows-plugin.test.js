import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolvePreinstalledPluginPaths } from "../src/config/plugins.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginDir = path.join(
  repoRoot,
  "resources",
  "openclaw-plugins",
  "oneclaw-workflows",
);

test("OneClaw Durable Work declares durable work and structured input tools", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    "utf8",
  ));
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));

  assert.equal(manifest.id, "oneclaw-workflows");
  assert.deepEqual(manifest.contracts.tools, ["oneclaw_work", "request_user_input"]);
  assert.equal(pkg.name, "@oneclaw/durable-work");
  assert.equal(pkg.version, manifest.version);
  assert.equal(pkg.openclaw.extensions[0], "./index.mjs");
  assert.equal(pkg.dependencies["@oneclaw/runtime-events"], "0.1.0");
  assert.equal(pkg.peerDependencies.openclaw, "2026.7.1");
});

test("OneClaw Durable Work captures only a loopback interaction broker", () => {
  const source = fs.readFileSync(path.join(pluginDir, "index.mjs"), "utf8");
  const runtimeSource = fs.readFileSync(
    path.join(pluginDir, "runtime-integration.mjs"),
    "utf8",
  );

  assert.match(source, /ONECLAW_INTERACTION_BROKER_URL/);
  assert.match(source, /ONECLAW_INTERACTION_BROKER_TOKEN/);
  assert.match(source, /OneClaw interaction broker must use loopback HTTP/);
  assert.match(runtimeSource, /authorization: `Bearer \$\{configuration\.token\}`/);
  assert.match(source, /api\.runtime\.tasks\.managedFlows\.fromToolContext/);
  assert.match(source, /runtimeContexts\.register/);
  assert.match(runtimeSource, /\/v1\/attentions/);
  assert.match(runtimeSource, /\/v1\/events\/pending/);
  assert.match(runtimeSource, /task\.snapshot/);
});

test("preinstalled plugin discovery includes the image-bundled workflow plugin", () => {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-workflows-plugins-"));
  const installedPlugin = path.join(
    pluginsDir,
    "node_modules",
    "@oneclaw",
    "durable-work",
  );
  fs.mkdirSync(installedPlugin, { recursive: true });

  const paths = resolvePreinstalledPluginPaths({ OPENCLAW_PLUGINS_DIR: pluginsDir });

  assert.deepEqual(paths, [installedPlugin]);
});
