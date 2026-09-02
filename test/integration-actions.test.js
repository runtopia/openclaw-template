import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadIntegrationActions } from "../src/integration/oneclaw.js";

test("integration action heartbeat snapshot comes from the installed manifest", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-actions-"));
  const manifestPath = path.join(directory, "oneclaw.actions.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema_version: 1,
    actions: [
      { id: "media.browse_templates" },
      { id: "gmail.latest_emails" },
    ],
  }));

  const snapshot = loadIntegrationActions(manifestPath);
  assert.deepEqual(snapshot.action_ids, ["gmail.latest_emails", "media.browse_templates"]);
  assert.match(snapshot.digest, /^sha256:[a-f0-9]{64}$/u);
});

test("missing integration action manifest reports no supported actions", () => {
  const snapshot = loadIntegrationActions("/missing/oneclaw.actions.json");
  assert.deepEqual(snapshot, { schema_version: 1, digest: "", action_ids: [] });
});
