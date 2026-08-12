import assert from "node:assert/strict";
import test from "node:test";

import { verifyLockedPluginVersions } from "../scripts/verify-openclaw-plugin-bundle.mjs";

const installedPackages = {
  "@oneclaw-plugins/channel": { version: "0.1.23" },
  "@oneclaw-plugins/runtime-events": { version: "0.1.2" },
};
const readInstalledPackage = (packageName) => installedPackages[packageName];

test("bundle verifier resolves installed versions from the lockfile for local tgz dependencies", () => {
  const manifest = { dependencies: {
    "@oneclaw-plugins/channel": "file:tarballs/channel.tgz",
    "@oneclaw-plugins/runtime-events": "0.1.2",
  } };
  const lockfile = { packages: {
    "node_modules/@oneclaw-plugins/channel": { version: "0.1.23" },
    "node_modules/@oneclaw-plugins/runtime-events": { version: "0.1.2" },
  } };

  assert.deepEqual(
    Object.fromEntries(verifyLockedPluginVersions(manifest, lockfile, readInstalledPackage)),
    {
      "@oneclaw-plugins/channel": "0.1.23",
      "@oneclaw-plugins/runtime-events": "0.1.2",
    },
  );
});

test("bundle verifier still rejects installed packages that differ from the lockfile", () => {
  const manifest = { dependencies: { "@oneclaw-plugins/channel": "file:tarballs/channel.tgz" } };
  const lockfile = { packages: {
    "node_modules/@oneclaw-plugins/channel": { version: "0.1.24" },
  } };

  assert.throws(
    () => verifyLockedPluginVersions(manifest, lockfile, readInstalledPackage),
    /Unexpected @oneclaw-plugins\/channel version: 0\.1\.23; expected 0\.1\.24/u,
  );
});

test("bundle verifier rejects a plugin dependency without a locked package version", () => {
  assert.throws(
    () => verifyLockedPluginVersions(
      { dependencies: { "@oneclaw-plugins/channel": "0.1.23" } },
      { packages: {} },
      readInstalledPackage,
    ),
    /Missing locked version for @oneclaw-plugins\/channel/u,
  );
});
