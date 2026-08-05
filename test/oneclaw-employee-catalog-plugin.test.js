import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildPreinstalledPluginInstallRecords,
  resolvePreinstalledPluginPaths,
} from "../src/config/plugins.js";

test("preinstalled employee catalog is discovered and recorded", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-employee-catalog-"));
  try {
    const pluginsDir = path.join(root, "plugins");
    const packageDir = path.join(
      pluginsDir,
      "node_modules",
      "@oneclaw-plugins",
      "employee-catalog",
    );
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "@oneclaw-plugins/employee-catalog", version: "0.4.12" }),
    );
    const env = { OPENCLAW_PLUGINS_DIR: pluginsDir };

    assert.deepEqual(resolvePreinstalledPluginPaths(env), [packageDir]);
    assert.deepEqual(buildPreinstalledPluginInstallRecords(env)["oneclaw-employee-catalog"], {
      source: "npm",
      spec: "@oneclaw-plugins/employee-catalog",
      resolvedName: "@oneclaw-plugins/employee-catalog",
      resolvedSpec: "@oneclaw-plugins/employee-catalog@0.4.12",
      version: "0.4.12",
      resolvedVersion: "0.4.12",
      installPath: packageDir,
      installedAt: "1970-01-01T00:00:00.000Z",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
