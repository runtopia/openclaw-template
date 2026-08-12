import assert from "node:assert/strict";
import test from "node:test";

import {
  buildInstallArgs,
  detectUpdates,
  getOneclawDependencies,
  verifyUpdatedBundle,
} from "../scripts/update-oneclaw-plugins.mjs";

test("updater selects only declared OneClaw packages and detects changed latest versions", () => {
  const dependencies = getOneclawDependencies({
    dependencies: {
      "@openclaw/slack": "1.0.0",
      "@oneclaw-plugins/search": "1.0.0",
      "@oneclaw-plugins/channel": "2.0.0",
    },
  });
  assert.deepEqual(dependencies, [
    ["@oneclaw-plugins/channel", "2.0.0"],
    ["@oneclaw-plugins/search", "1.0.0"],
  ]);
  assert.deepEqual(detectUpdates(dependencies, {
    "@oneclaw-plugins/channel": "2.0.0",
    "@oneclaw-plugins/search": "1.1.0",
  }), [{
    packageName: "@oneclaw-plugins/search",
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
  }]);
});

test("updater uses an exact lockfile-only npm install", () => {
  const args = buildInstallArgs([{
    packageName: "@oneclaw-plugins/channel",
    latestVersion: "2.1.0",
  }], "https://registry.example.test");
  assert.deepEqual(args, [
    "install",
    "--package-lock-only",
    "--save-exact",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    "--registry=https://registry.example.test",
    "@oneclaw-plugins/channel@2.1.0",
  ]);
});

test("updater verifies manifest and lockfile convergence", () => {
  const packageName = "@oneclaw-plugins/channel";
  const manifest = { dependencies: { [packageName]: "2.1.0" } };
  const lockfile = { packages: {
    "": { dependencies: { [packageName]: "2.1.0" } },
    [`node_modules/${packageName}`]: {
      version: "2.1.0",
      resolved: "https://registry.npmjs.org/@oneclaw-plugins/channel/-/channel-2.1.0.tgz",
      integrity: "sha512-example",
    },
  } };
  assert.doesNotThrow(() => verifyUpdatedBundle(manifest, lockfile, { [packageName]: "2.1.0" }));
  assert.throws(
    () => verifyUpdatedBundle(manifest, lockfile, { [packageName]: "2.2.0" }),
    /package.json is not pinned to 2.2.0/u,
  );
});
