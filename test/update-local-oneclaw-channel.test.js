import assert from "node:assert/strict";
import test from "node:test";

import {
  contentAddressedArchiveName,
  obsoleteChannelArchives,
  parseArguments,
  updateChannelDependency,
  validatePluginGitState,
} from "../scripts/update-local-oneclaw-channel.mjs";

test("local Channel updater defaults to the sibling plugin repository", () => {
  assert.deepEqual(parseArguments([], "/workspace/openclaw-template", {}), {
    pluginRepo: "/workspace/oneclaw-plugins",
  });
  assert.deepEqual(parseArguments(["--plugin-repo", "../plugins"], "/workspace/template", {}), {
    pluginRepo: "/workspace/plugins",
  });
  assert.throws(() => parseArguments(["--plugin-repo"], "/workspace/template", {}), /requires a path/u);
  assert.throws(() => parseArguments(["--unknown"], "/workspace/template", {}), /Unknown argument/u);
});

test("local Channel updater creates a content-addressed dependency", () => {
  const sha256 = "a".repeat(64);
  const archive = contentAddressedArchiveName("0.1.24-beta.1", sha256);
  assert.equal(archive, `oneclaw-plugins-channel-0.1.24-beta.1-${sha256}.tgz`);
  const manifest = updateChannelDependency({
    private: true,
    dependencies: { "@oneclaw-plugins/channel": "0.1.23", other: "1.0.0" },
  }, archive);
  assert.equal(manifest.dependencies["@oneclaw-plugins/channel"], `file:tarballs/${archive}`);
  assert.equal(manifest.dependencies.other, "1.0.0");
  assert.throws(() => contentAddressedArchiveName("latest", sha256), /Invalid Channel version/u);
});

test("local Channel updater removes only superseded Channel archives", () => {
  const keep = `oneclaw-plugins-channel-0.1.24-${"b".repeat(64)}.tgz`;
  const old = `oneclaw-plugins-channel-0.1.23-${"a".repeat(64)}.tgz`;
  assert.deepEqual(obsoleteChannelArchives([keep, old, "other-plugin.tgz", "README.md"], keep), [old]);
});

test("local Channel updater requires committed and pushed develop", () => {
  assert.doesNotThrow(() => validatePluginGitState({ branch: "develop", status: "", ahead: 0, behind: 0 }));
  assert.throws(
    () => validatePluginGitState({ branch: "main", status: "", ahead: 0, behind: 0 }),
    /must be on develop/u,
  );
  assert.throws(
    () => validatePluginGitState({ branch: "develop", status: " M file", ahead: 0, behind: 0 }),
    /uncommitted changes/u,
  );
  assert.throws(
    () => validatePluginGitState({ branch: "develop", status: "", ahead: 1, behind: 0 }),
    /must equal origin\/develop/u,
  );
});
