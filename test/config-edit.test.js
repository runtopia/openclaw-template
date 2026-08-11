import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { patchConfig, setIn } from "../src/config/edit.js";

test("patchConfig atomically writes changes and leaves an unchanged config untouched", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-config-edit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { port: 1 } }, null, 2));
  const originalInode = fs.statSync(configPath).ino;

  patchConfig(configPath, (cfg) => setIn(cfg, "gateway.port", 2));
  assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).gateway.port, 2);
  const changedInode = fs.statSync(configPath).ino;
  assert.notEqual(changedInode, originalInode, "changed config should be promoted atomically");

  patchConfig(configPath, (cfg) => setIn(cfg, "gateway.port", 2));
  assert.equal(fs.statSync(configPath).ino, changedInode, "no-op patch should not rewrite config");
  assert.deepEqual(
    fs.readdirSync(root).sort(),
    ["openclaw.json"],
    "temporary config files should not remain",
  );
});
