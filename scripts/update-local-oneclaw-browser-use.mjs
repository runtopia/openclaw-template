#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArguments,
  validatePluginGitState,
} from "./update-local-oneclaw-channel.mjs";

const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(templateRoot, "resources", "openclaw-plugin-bundle");
const manifestPath = path.join(bundleDir, "package.json");
const lockfilePath = path.join(bundleDir, "package-lock.json");
const tarballsDir = path.join(bundleDir, "tarballs");
const packageName = "@oneclaw-plugins/browser-use";
const archivePattern = /^oneclaw-plugins-browser-use-[0-9A-Za-z.+-]+-[a-f0-9]{64}\.tgz$/u;

function run(command, args, cwd, capture = false) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

function assertRepositoryReady(pluginRepo) {
  run("git", ["fetch", "origin", "develop"], pluginRepo);
  const branch = run("git", ["branch", "--show-current"], pluginRepo, true).trim();
  const status = run("git", ["status", "--porcelain"], pluginRepo, true);
  const [ahead, behind] = run(
    "git",
    ["rev-list", "--left-right", "--count", "HEAD...origin/develop"],
    pluginRepo,
    true,
  ).trim().split(/\s+/u).map(Number);
  validatePluginGitState({ branch, status, ahead, behind });
}

function archiveName(version, sha256) {
  return `oneclaw-plugins-browser-use-${version}-${sha256}.tgz`;
}

export function main(argv = process.argv.slice(2)) {
  const { pluginRepo } = parseArguments(argv, templateRoot);
  assertRepositoryReady(pluginRepo);
  const pluginDir = path.join(pluginRepo, "plugins", "oneclaw-browser-use");
  const pluginPackage = readJson(path.join(pluginDir, "package.json"));
  if (pluginPackage.name !== packageName) {
    throw new Error(`Unexpected Browser Use package name: ${pluginPackage.name || "(missing)"}`);
  }

  run("npm", ["test"], pluginDir);
  run("npm", ["run", "check"], pluginDir);

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-browser-use-pack-"));
  const manifestSnapshot = fs.readFileSync(manifestPath);
  const lockfileSnapshot = fs.readFileSync(lockfilePath);
  const oldArchives = fs.readdirSync(tarballsDir).filter((entry) => archivePattern.test(entry));
  const archiveSnapshots = new Map(
    oldArchives.map((entry) => [entry, fs.readFileSync(path.join(tarballsDir, entry))]),
  );
  try {
    run("npm", ["pack", "--ignore-scripts", "--pack-destination", temporaryDir], pluginDir);
    const packed = fs.readdirSync(temporaryDir).filter((entry) => entry.endsWith(".tgz"));
    if (packed.length !== 1) throw new Error(`Expected one Browser Use tgz, found ${packed.length}`);
    const packedPath = path.join(temporaryDir, packed[0]);
    const sha256 = createHash("sha256").update(fs.readFileSync(packedPath)).digest("hex");
    const nextArchive = archiveName(pluginPackage.version, sha256);
    const destination = path.join(tarballsDir, nextArchive);
    if (fs.existsSync(destination)) {
      if (!fs.readFileSync(destination).equals(fs.readFileSync(packedPath))) {
        throw new Error(`Refusing to replace bytes of immutable archive: ${nextArchive}`);
      }
    } else {
      fs.copyFileSync(packedPath, destination);
    }

    const manifest = readJson(manifestPath);
    manifest.dependencies[packageName] = `file:tarballs/${nextArchive}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run("npm", [
      "install", "--package-lock-only", "--ignore-scripts", "--legacy-peer-deps",
      "--no-audit", "--no-fund",
    ], bundleDir);
    for (const archive of oldArchives) {
      if (archive !== nextArchive) fs.rmSync(path.join(tarballsDir, archive));
    }
    run("node", ["--test", "test/oneclaw-plugin-bundle.test.js"], templateRoot);
    console.log(`Updated Template Browser Use bundle: ${nextArchive}`);
  } catch (error) {
    fs.writeFileSync(manifestPath, manifestSnapshot);
    fs.writeFileSync(lockfilePath, lockfileSnapshot);
    for (const entry of fs.readdirSync(tarballsDir).filter((value) => archivePattern.test(value))) {
      fs.rmSync(path.join(tarballsDir, entry));
    }
    for (const [entry, contents] of archiveSnapshots) {
      fs.writeFileSync(path.join(tarballsDir, entry), contents);
    }
    throw error;
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[update-local-oneclaw-browser-use] ${error.message}`);
    process.exitCode = 1;
  }
}
