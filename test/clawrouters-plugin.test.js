import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPreinstalledPluginInstallRecords,
  resolvePreinstalledPluginPaths,
} from "../src/config/plugins.js";

test("preinstalled ClawRouters npm package is discovered and recorded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-clawrouters-"));
  try {
    const pluginsDir = path.join(root, "plugins");
    const packageDir = path.join(
      pluginsDir,
      "node_modules",
      "@oneclaw-plugins",
      "clawrouters",
    );
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@oneclaw-plugins/clawrouters", version: "0.4.1" }),
    );
    const env = { OPENCLAW_PLUGINS_DIR: pluginsDir };

    assert.deepEqual(resolvePreinstalledPluginPaths(env), [packageDir]);
    assert.deepEqual(buildPreinstalledPluginInstallRecords(env).clawrouters, {
      source: "npm",
      spec: "@oneclaw-plugins/clawrouters",
      resolvedName: "@oneclaw-plugins/clawrouters",
      resolvedSpec: "@oneclaw-plugins/clawrouters@0.4.1",
      version: "0.4.1",
      resolvedVersion: "0.4.1",
      installPath: packageDir,
      installedAt: "1970-01-01T00:00:00.000Z",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
