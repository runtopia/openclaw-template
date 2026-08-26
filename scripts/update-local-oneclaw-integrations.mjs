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
const packageName = "@oneclaw-plugins/integrations";
const archivePattern = /^oneclaw-plugins-integrations-[0-9A-Za-z.+-]+-[a-f0-9]{64}\.tgz$/u;

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
  return `oneclaw-plugins-integrations-${version}-${sha256}.tgz`;
}

export function main(argv = process.argv.slice(2)) {
  const { pluginRepo } = parseArguments(argv, templateRoot);
  assertRepositoryReady(pluginRepo);
  const pluginDir = path.join(pluginRepo, "plugins", "oneclaw-integrations");
  const pluginPackage = readJson(path.join(pluginDir, "package.json"));
  if (pluginPackage.name !== packageName) {
    throw new Error(`Unexpected Integrations package name: ${pluginPackage.name || "(missing)"}`);
  }

  run("node", ["scripts/validate-plugin-releases.mjs", "oneclaw-integrations"], pluginRepo);
  for (const args of [
    ["install", "--frozen-lockfile"],
    ["test"],
    ["typecheck"],
    ["build"],
  ]) {
    run("corepack", ["pnpm", ...args], pluginDir);
  }

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-integrations-pack-"));
  const manifestSnapshot = fs.readFileSync(manifestPath);
  const lockfileSnapshot = fs.readFileSync(lockfilePath);
  const oldArchives = fs.readdirSync(tarballsDir).filter((entry) => archivePattern.test(entry));
  try {
    run("corepack", ["pnpm", "pack", "--pack-destination", temporaryDir], pluginDir);
    const packed = fs.readdirSync(temporaryDir).filter((entry) => entry.endsWith(".tgz"));
    if (packed.length !== 1) throw new Error(`Expected one Integrations tgz, found ${packed.length}`);
    const packedPath = path.join(temporaryDir, packed[0]);
    const sha256 = createHash("sha256").update(fs.readFileSync(packedPath)).digest("hex");
    const nextArchive = archiveName(pluginPackage.version, sha256);
    fs.copyFileSync(packedPath, path.join(tarballsDir, nextArchive));

    const manifest = readJson(manifestPath);
    manifest.dependencies[packageName] = `file:tarballs/${nextArchive}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    run("npm", [
      "install", "--package-lock-only", "--ignore-scripts", "--legacy-peer-deps",
      "--no-audit", "--no-fund",
    ], bundleDir);
    run("node", ["--test", "test/oneclaw-plugin-bundle.test.js"], templateRoot);
    for (const archive of oldArchives) {
      if (archive !== nextArchive) fs.rmSync(path.join(tarballsDir, archive));
    }
    console.log(`Updated Template Integrations bundle: ${nextArchive}`);
  } catch (error) {
    fs.writeFileSync(manifestPath, manifestSnapshot);
    fs.writeFileSync(lockfilePath, lockfileSnapshot);
    for (const entry of fs.readdirSync(tarballsDir)) {
      if (archivePattern.test(entry) && !oldArchives.includes(entry)) {
        fs.rmSync(path.join(tarballsDir, entry));
      }
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
    console.error(`[update-local-oneclaw-integrations] ${error.message}`);
    process.exitCode = 1;
  }
}

