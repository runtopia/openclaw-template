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

test("bundled employee catalog is excluded from ordinary discovery and install records", () => {
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

    assert.deepEqual(resolvePreinstalledPluginPaths(env), []);
    assert.equal(
      buildPreinstalledPluginInstallRecords(env)["oneclaw-employee-catalog"],
      undefined,
    );

    const cfg = {
      plugins: {
        installs: {
          "oneclaw-workflows": { installPath: "/old/durable-work" },
          "oneclaw-employee-catalog": { installPath: packageDir },
        },
      },
    };
    assert.equal(applyPreinstalledPluginInstallRecords(cfg, env), true);
    assert.deepEqual(cfg.plugins.installs, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
