import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(repoRoot, "resources", "openclaw-plugin-bundle");
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "package.json"), "utf8"));
const lockfile = JSON.parse(fs.readFileSync(path.join(bundleDir, "package-lock.json"), "utf8"));

const ONECLAW_PACKAGES = Object.fromEntries(
  Object.entries(manifest.dependencies)
    .filter(([packageName]) => packageName.startsWith("@oneclaw-plugins/")),
);

test("cloud Runtime declares exact official OneClaw plugin versions", () => {
  assert.equal(manifest.private, true);
  assert.deepEqual(Object.keys(ONECLAW_PACKAGES).sort(), [
    "@oneclaw-plugins/channel",
    "@oneclaw-plugins/clawrouters",
    "@oneclaw-plugins/openclaw-search",
    "@oneclaw-plugins/runtime-events",
  ]);
  assert.doesNotMatch(JSON.stringify(lockfile), /git\+ssh:/u);
  for (const [packageName, version] of Object.entries(ONECLAW_PACKAGES)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
    assert.equal(manifest.dependencies[packageName], version);
    assert.equal(lockfile.packages[""].dependencies[packageName], version);

    const entry = lockfile.packages[`node_modules/${packageName}`];
    assert.equal(entry.version, version);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//u);
    assert.match(entry.integrity, /^sha512-/u);
  }
});

test("cloud Runtime does not ship retired collaboration plugins", () => {
  for (const packageName of [
    "@oneclaw-plugins/durable-work",
    "@oneclaw-plugins/employee-catalog",
  ]) {
    assert.equal(manifest.dependencies[packageName], undefined);
    assert.equal(lockfile.packages[""].dependencies[packageName], undefined);
    assert.equal(lockfile.packages[`node_modules/${packageName}`], undefined);
  }
});

test("plugin source and release tarballs are owned by the official package repository", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "resources", "openclaw-plugins")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "resources", "oneclaw-packages")), false);
});
