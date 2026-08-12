#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function verifyLockedPluginVersions(manifest, lockfile, readInstalledPackage) {
  const lockedVersions = new Map();
  const pluginNames = Object.keys(manifest.dependencies || {})
    .filter((packageName) => packageName.startsWith("@oneclaw-plugins/"));

  for (const packageName of pluginNames) {
    const lockedVersion = lockfile.packages?.[`node_modules/${packageName}`]?.version;
    if (typeof lockedVersion !== "string" || lockedVersion.length === 0) {
      throw new Error(`Missing locked version for ${packageName}`);
    }
    const installedVersion = readInstalledPackage(packageName)?.version;
    if (installedVersion !== lockedVersion) {
      throw new Error(
        `Unexpected ${packageName} version: ${installedVersion || "(missing)"}; expected ${lockedVersion}`,
      );
    }
    lockedVersions.set(packageName, lockedVersion);
  }

  return lockedVersions;
}

export function verifyPluginBundle(root, expectedOpenClawVersion = "2026.7.1") {
  const manifest = readJson(path.join(root, "package.json"));
  const lockfile = readJson(path.join(root, "package-lock.json"));
  const readInstalledPackage = (packageName) => (
    readJson(path.join(root, "node_modules", packageName, "package.json"))
  );
  const lockedVersions = verifyLockedPluginVersions(manifest, lockfile, readInstalledPackage);
  const require = createRequire(path.join(root, "package.json"));

  const runtimeSdkVersion = require("@oneclaw-plugins/runtime-events").runtimeEventSdkVersion();
  const expectedRuntimeSdkVersion = lockedVersions.get("@oneclaw-plugins/runtime-events");
  if (runtimeSdkVersion !== expectedRuntimeSdkVersion) {
    throw new Error(
      `Unexpected Runtime Event SDK version: ${runtimeSdkVersion}; expected ${expectedRuntimeSdkVersion}`,
    );
  }

  const channelPackage = readInstalledPackage("@oneclaw-plugins/channel");
  if (channelPackage.peerDependencies?.openclaw !== expectedOpenClawVersion) {
    throw new Error(
      `Unexpected OpenClaw peer version: ${channelPackage.peerDependencies?.openclaw || "(missing)"}`,
    );
  }
}

const isCli = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  const root = process.argv[2];
  if (!root) throw new Error("usage: verify-openclaw-plugin-bundle.mjs <bundle-root> [openclaw-version]");
  verifyPluginBundle(root, process.argv[3]);
}
