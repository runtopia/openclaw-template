import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolvePreinstalledPluginPaths } from "../src/config/plugins.js";

test("preinstalled plugin discovery includes the npm-installed workflow plugin", () => {
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-workflows-plugins-"));
  const installedPlugin = path.join(
    pluginsDir,
    "node_modules",
    "@oneclaw-plugins",
    "durable-work",
  );
  fs.mkdirSync(installedPlugin, { recursive: true });

  const paths = resolvePreinstalledPluginPaths({ OPENCLAW_PLUGINS_DIR: pluginsDir });

  assert.deepEqual(paths, [installedPlugin]);
});
