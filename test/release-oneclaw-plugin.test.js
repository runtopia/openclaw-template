import assert from "node:assert/strict";
import test from "node:test";

import {
  directReleaseDependencies,
  nextTemplateTag,
  parseArguments,
  unreferencedTarballs,
  validateRepositoryState,
} from "../scripts/release-oneclaw-plugin.mjs";

test("release command resolves its sibling plugin repository and explicit tag", () => {
  assert.deepEqual(
    parseArguments(["oneclaw-channel", "--tag", "v4.1.4", "--plugin-repo", "../plugins"], "/work/template", {}),
    {
      pluginId: "oneclaw-channel",
      templateTag: "v4.1.4",
      pluginRepo: "/work/plugins",
    },
  );
});

test("release command rejects malformed arguments", () => {
  assert.throws(() => parseArguments([], "/work/template", {}), /usage:/u);
  assert.throws(() => parseArguments(["oneclaw-channel", "--tag", "main"], "/work/template", {}), /Invalid/u);
});

test("release requires clean synchronized main repositories", () => {
  assert.doesNotThrow(() => validateRepositoryState("repo", { branch: "main", status: "", ahead: 0, behind: 0 }));
  assert.throws(
    () => validateRepositoryState("repo", { branch: "develop", status: "", ahead: 0, behind: 0 }),
    /must be on main/u,
  );
  assert.throws(
    () => validateRepositoryState("repo", { branch: "main", status: " M file", ahead: 0, behind: 0 }),
    /uncommitted/u,
  );
});

test("release derives the next stable Template patch tag", () => {
  assert.equal(nextTemplateTag(["v4.0.9", "v4.1.3", "v4.1.2", "not-a-release"]), "v4.1.4");
});

test("release locks every directly declared artifact and requires the primary package", () => {
  const manifest = { dependencies: {
    "@oneclaw-plugins/channel": "file:tarballs/channel.tgz",
    "@oneclaw-plugins/runtime-events": "0.1.2",
  } };
  const release = {
    plugin: { package: "@oneclaw-plugins/channel" },
    artifacts: [
      { package: "@oneclaw-plugins/runtime-events", version: "0.1.2" },
      { package: "@oneclaw-plugins/channel", version: "0.1.24" },
    ],
  };
  assert.deepEqual(directReleaseDependencies(manifest, release), [
    { packageName: "@oneclaw-plugins/runtime-events", currentVersion: "0.1.2", latestVersion: "0.1.2" },
    { packageName: "@oneclaw-plugins/channel", currentVersion: "file:tarballs/channel.tgz", latestVersion: "0.1.24" },
  ]);
  assert.throws(
    () => directReleaseDependencies({ dependencies: {} }, release),
    /is not declared/u,
  );
});

test("release removes only tarballs no longer referenced by the bundle", () => {
  assert.deepEqual(
    unreferencedTarballs(
      ["keep.tgz", "remove.tgz", "README.md"],
      { dependencies: { local: "file:tarballs/keep.tgz", remote: "1.0.0" } },
    ),
    ["remove.tgz"],
  );
});
