import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

function bundledChannelMonitorSource() {
  const channelSpec = ONECLAW_PACKAGES["@oneclaw-plugins/channel"];
  const tarballPath = path.join(bundleDir, channelSpec.slice("file:".length));
  const entries = execFileSync("tar", ["-tzf", tarballPath], { encoding: "utf8" }).trim().split("\n");
  const monitorEntry = entries.find((entry) => /^package\/dist\/monitor-.*\.mjs$/u.test(entry));
  assert.ok(monitorEntry, "Channel archive should contain its compiled monitor entry");
  return execFileSync("tar", ["-xOzf", tarballPath, monitorEntry], { encoding: "utf8" });
}

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

test("bundled Channel preserves detached replies and terminal Execution notices", () => {
  const source = bundledChannelMonitorSource();
  assert.match(source, /preparedMessageId/u);
  assert.match(source, /deliveryIntentId/u);
  assert.match(source, /Delivered a background Session reply\./u);
  assert.match(source, /runningExecutionBlockIdsByToolName/u);
  assert.match(source, /acceptAgentToolResult\(payload\)/u);
  assert.match(source, /params\.stream\.acceptAgentToolResult\(event\)/u);
});

test("plugin source stays outside the template while local deployment tarballs are content-addressed", () => {
  assert.equal(fs.existsSync(path.join(repoRoot, "resources", "openclaw-plugins")), false);
  assert.equal(fs.existsSync(path.join(repoRoot, "resources", "oneclaw-packages")), false);
  const tarballs = fs.readdirSync(path.join(bundleDir, "tarballs"));
  assert.deepEqual(tarballs, [path.basename(ONECLAW_PACKAGES["@oneclaw-plugins/channel"].slice("file:".length))]);
});
