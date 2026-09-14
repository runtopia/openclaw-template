import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadIntegrationActions } from "../src/integration/oneclaw.js";

test("new executors opt into dynamic actions independently of legacy card IDs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-dynamic-actions-"));
  try {
    const manifestPath = path.join(directory, "oneclaw.actions.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ schema_version: 1, groups: [{ id: "old" }], actions: [{ id: "old.card" }] }));
    fs.writeFileSync(path.join(directory, "oneclaw.executors.json"), JSON.stringify({ schema_version: 1, contracts: ["guidance.v1"] }));
    const snapshot = loadIntegrationActions(manifestPath);
    assert.equal(snapshot.dynamic_version, 1);
    assert.deepEqual(snapshot.executors, ["guidance.v1"]);
    assert.deepEqual(snapshot.action_ids, ["old.card"]);
    fs.writeFileSync(path.join(directory, "oneclaw.executors.json"), JSON.stringify({ schema_version: 2, contracts: ["guidance.v1"] }));
    assert.equal(loadIntegrationActions(manifestPath).dynamic_version, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("integration action heartbeat snapshot comes from the installed manifest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-actions-"));
  const manifestPath = path.join(directory, "oneclaw.actions.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1,
    groups: [{ id: "media" }],
    actions: [
      { id: "media.browse_templates" },
      { id: "gmail.latest_emails" },
    ],
  }));

  const snapshot = loadIntegrationActions(manifestPath);
  assert.deepEqual(snapshot.action_ids, ["gmail.latest_emails", "media.browse_templates"]);
  assert.match(snapshot.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(snapshot.manifest.groups[0].id, "media");
});

test("missing integration action manifest reports no supported actions", () => {
  const snapshot = loadIntegrationActions("/missing/oneclaw.actions.json");
  assert.deepEqual(snapshot, {
    schema_version: 1,
    digest: "",
    action_ids: [],
    manifest: null,
  });
});
