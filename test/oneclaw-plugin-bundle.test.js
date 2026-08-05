import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(repoRoot, "resources", "openclaw-plugin-bundle");
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "package.json"), "utf8"));
const lockfile = JSON.parse(fs.readFileSync(path.join(bundleDir, "package-lock.json"), "utf8"));

const ONECLAW_PACKAGES = {
  "@oneclaw-plugins/clawrouters": "0.4.1",
  "@oneclaw-plugins/runtime-events": "0.1.1",
  "@oneclaw-plugins/channel": "0.1.5",
  "@oneclaw-plugins/openclaw-search": "0.2.0",
  "@oneclaw-plugins/durable-work": "0.9.1",
  "@oneclaw-plugins/employee-catalog": "0.5.0",
};

test("cloud Runtime declares exact official OneClaw plugin versions", () => {
  assert.equal(manifest.private, true);
  assert.doesNotMatch(JSON.stringify(lockfile), /git\+ssh:/u);
  for (const [packageName, version] of Object.entries(ONECLAW_PACKAGES)) {
    assert.equal(manifest.dependencies[packageName], version);
    assert.equal(lockfile.packages[""].dependencies[packageName], version);

    const entry = lockfile.packages[`node_modules/${packageName}`];
    assert.equal(entry.version, version);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//u);
    assert.match(entry.integrity, /^sha512-/u);
  }
});

test("plugin source and release tarballs are owned by the official package repository", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "resources", "openclaw-plugins")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "resources", "oneclaw-packages")), false);
});
