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
  "oneclaw-search",
);

test("OneClaw Search declares the OpenClaw web-search provider contract", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    "utf8",
  ));
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));

  assert.equal(manifest.id, "oneclaw-search");
  assert.deepEqual(manifest.contracts.webSearchProviders, ["oneclaw-search"]);
  assert.equal(pkg.openclaw.extensions[0], "./index.mjs");
});

test("OneClaw Search uses the cloud child key and wrapped external content", () => {
  const source = fs.readFileSync(path.join(pluginDir, "index.mjs"), "utf8");

  assert.match(source, /Authorization: `Bearer \$\{apiKey\}`/);
  assert.match(source, /"X-OneClaw-Client-Platform": "cloud"/);
  assert.match(source, /source: "web_search"/);
  assert.match(source, /wrapWebContent\(title, "web_search"\)/);
  assert.match(source, /registerWebSearchProvider/);
});

test("preinstalled plugin discovery includes the image-bundled search provider", () => {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-search-plugins-"));
  const installedPlugin = path.join(
    pluginsDir,
    "node_modules",
    "@oneclaw",
    "openclaw-search",
  );
  fs.mkdirSync(installedPlugin, { recursive: true });

  const paths = resolvePreinstalledPluginPaths({ OPENCLAW_PLUGINS_DIR: pluginsDir });

  assert.deepEqual(paths, [installedPlugin]);
});
