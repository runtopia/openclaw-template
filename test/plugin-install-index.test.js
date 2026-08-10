import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { syncPreinstalledPluginInstallIndex } from "../src/config/plugin-install-index.js";
import {
  buildPreinstalledPluginInstallRecords,
  cleanupStalePreinstalledExtensions,
} from "../src/config/plugins.js";

function writePlugin(packageDir, { name, version, pluginId }) {
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({ name, version }));
  fs.writeFileSync(
    path.join(packageDir, "openclaw.plugin.json"),
    JSON.stringify({ id: pluginId }),
  );
}

function readInstallRecords(stateDir) {
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"));
  try {
    const row = db.prepare(`
      SELECT install_records_json
        FROM installed_plugin_index
       WHERE index_key = 'installed-plugin-index'
    `).get();
    return JSON.parse(row.install_records_json);
  } finally {
    db.close();
  }
}

test("preinstalled plugin SQLite records replace Doctor-managed volume installs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-plugin-index-"));
  try {
    const stateDir = path.join(root, "state-dir");
    const pluginsDir = path.join(root, "plugins");
    const whatsappDir = path.join(pluginsDir, "node_modules", "@openclaw", "whatsapp");
    const weixinDir = path.join(
      pluginsDir,
      "node_modules",
      "@tencent-weixin",
      "openclaw-weixin",
    );
    writePlugin(whatsappDir, {
      name: "@openclaw/whatsapp",
      version: "2026.7.1",
      pluginId: "whatsapp",
    });
    writePlugin(weixinDir, {
      name: "@tencent-weixin/openclaw-weixin",
      version: "2.4.6",
      pluginId: "openclaw-weixin",
    });
    const env = { OPENCLAW_PLUGINS_DIR: pluginsDir };
    const records = buildPreinstalledPluginInstallRecords(env);

    const doctorRecord = {
      source: "clawhub",
      spec: "clawhub:@openclaw/whatsapp",
      installPath: path.join(stateDir, "extensions", "whatsapp"),
      version: "2026.7.1",
    };
    assert.equal(syncPreinstalledPluginInstallIndex(
      stateDir,
      { whatsapp: doctorRecord },
      { now: 1 },
    ).ok, true);
    const result = syncPreinstalledPluginInstallIndex(stateDir, records, { now: 2 });

    assert.deepEqual(result, {
      ok: true,
      changed: true,
      sqlitePath: path.join(stateDir, "state", "openclaw.sqlite"),
    });
    const installed = readInstallRecords(stateDir);
    assert.equal(installed.whatsapp.source, "npm");
    assert.equal(installed.whatsapp.installPath, whatsappDir);
    assert.equal(installed["openclaw-weixin"].installPath, weixinDir);
    assert.equal(
      syncPreinstalledPluginInstallIndex(stateDir, records, { now: 3 }).changed,
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("duplicate volume plugins are removed only after the SQLite index is ready", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-plugin-cleanup-"));
  try {
    const stateDir = path.join(root, "state-dir");
    const pluginsDir = path.join(root, "plugins");
    writePlugin(path.join(pluginsDir, "node_modules", "@openclaw", "whatsapp"), {
      name: "@openclaw/whatsapp",
      version: "2026.7.1",
      pluginId: "whatsapp",
    });
    writePlugin(
      path.join(pluginsDir, "node_modules", "@tencent-weixin", "openclaw-weixin"),
      {
        name: "@tencent-weixin/openclaw-weixin",
        version: "2.4.6",
        pluginId: "openclaw-weixin",
      },
    );
    const staleExtension = path.join(stateDir, "extensions", "whatsapp");
    writePlugin(staleExtension, {
      name: "@openclaw/whatsapp",
      version: "2026.7.1",
      pluginId: "whatsapp",
    });
    const managedProject = path.join(stateDir, "npm", "projects", "tencent-weixin-managed");
    writePlugin(
      path.join(managedProject, "node_modules", "@tencent-weixin", "openclaw-weixin"),
      {
        name: "@tencent-weixin/openclaw-weixin",
        version: "2.4.6",
        pluginId: "openclaw-weixin",
      },
    );
    const unrelatedProject = path.join(stateDir, "npm", "projects", "user-plugin");
    writePlugin(path.join(unrelatedProject, "node_modules", "example-plugin"), {
      name: "example-plugin",
      version: "1.0.0",
      pluginId: "example-plugin",
    });
    const env = { OPENCLAW_PLUGINS_DIR: pluginsDir };

    cleanupStalePreinstalledExtensions(stateDir, env, { installIndexReady: false });
    assert.equal(fs.existsSync(staleExtension), true);
    assert.equal(fs.existsSync(managedProject), true);

    cleanupStalePreinstalledExtensions(stateDir, env, { installIndexReady: true });
    assert.equal(fs.existsSync(staleExtension), false);
    assert.equal(fs.existsSync(managedProject), false);
    assert.equal(fs.existsSync(unrelatedProject), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
