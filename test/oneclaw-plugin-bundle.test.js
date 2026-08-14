import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

test("cloud Runtime declares locked OneClaw plugin artifacts", () => {
  assert.equal(manifest.private, true);
  assert.deepEqual(Object.keys(ONECLAW_PACKAGES).sort(), [
    "@oneclaw-plugins/channel",
    "@oneclaw-plugins/clawrouters",
    "@oneclaw-plugins/openclaw-search",
    "@oneclaw-plugins/runtime-events",
  ]);
  assert.doesNotMatch(JSON.stringify(lockfile), /git\+ssh:/u);
  const channelSpec = ONECLAW_PACKAGES["@oneclaw-plugins/channel"];
  const localMatch = channelSpec.match(
    /^file:(tarballs\/oneclaw-plugins-channel-[0-9A-Za-z.+-]+-([a-f0-9]{64})\.tgz)$/u,
  );
  assert.ok(localMatch, "Channel should use a content-addressed local tgz before npm release");
  const [, relativeTarball, expectedSha256] = localMatch;
  const tarballPath = path.join(bundleDir, relativeTarball);
  assert.equal(fs.existsSync(tarballPath), true);
  assert.equal(
    createHash("sha256").update(fs.readFileSync(tarballPath)).digest("hex"),
    expectedSha256,
  );
  assert.equal(lockfile.packages[""].dependencies["@oneclaw-plugins/channel"], channelSpec);
  const channelEntry = lockfile.packages["node_modules/@oneclaw-plugins/channel"];
  assert.equal(channelEntry.resolved, channelSpec);
  assert.match(channelEntry.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
  assert.match(channelEntry.integrity, /^sha512-/u);

  for (const [packageName, version] of Object.entries(ONECLAW_PACKAGES)
    .filter(([packageName]) => packageName !== "@oneclaw-plugins/channel")) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u);
    assert.equal(manifest.dependencies[packageName], version);
    assert.equal(lockfile.packages[""].dependencies[packageName], version);

    const entry = lockfile.packages[`node_modules/${packageName}`];
    assert.equal(entry.version, version);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//u);
    assert.match(entry.integrity, /^sha512-/u);
  }
});

test("production recovery keeps the schema-v6 Channel artifact pinned", () => {
  const channelSpec = ONECLAW_PACKAGES["@oneclaw-plugins/channel"];
  const channelEntry = lockfile.packages["node_modules/@oneclaw-plugins/channel"];
  assert.equal(channelEntry.version, "0.1.23");
  assert.match(
    channelSpec,
    /^file:tarballs\/oneclaw-plugins-channel-0\.1\.23-[a-f0-9]{64}\.tgz$/u,
  );
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

test("plugin source stays outside the template while local deployment tarballs are content-addressed", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "resources", "openclaw-plugins")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "resources", "oneclaw-packages")), false);
  const tarballs = fs.readdirSync(path.join(bundleDir, "tarballs"));
  assert.deepEqual(tarballs, [path.basename(ONECLAW_PACKAGES["@oneclaw-plugins/channel"].slice("file:".length))]);
});
