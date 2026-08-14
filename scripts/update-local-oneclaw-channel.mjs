#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(repoRoot, "resources", "openclaw-plugin-bundle");
const manifestPath = path.join(bundleDir, "package.json");
const lockfilePath = path.join(bundleDir, "package-lock.json");
const tarballsDir = path.join(bundleDir, "tarballs");
const channelPackageName = "@oneclaw-plugins/channel";
const channelArchivePattern = /^oneclaw-plugins-channel-[0-9A-Za-z.+-]+-[a-f0-9]{64}\.tgz$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

export function parseArguments(argv, templateRoot = repoRoot, env = process.env) {
  let pluginRepo = env.ONECLAW_PLUGINS_REPO?.trim();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--plugin-repo") {
      throw new Error(`Unknown argument: ${argv[index]}`);
    }
    pluginRepo = argv[index + 1]?.trim();
    if (!pluginRepo) throw new Error("--plugin-repo requires a path");
    index += 1;
  }
  return {
    pluginRepo: path.resolve(templateRoot, pluginRepo || "../oneclaw-plugins"),
  };
}

export function contentAddressedArchiveName(version, sha256) {
  if (!versionPattern.test(version)) throw new Error(`Invalid Channel version: ${version}`);
  if (!/^[a-f0-9]{64}$/u.test(sha256)) throw new Error(`Invalid Channel SHA-256: ${sha256}`);
  return `oneclaw-plugins-channel-${version}-${sha256}.tgz`;
}

export function updateChannelDependency(manifest, archiveName) {
  if (!manifest.dependencies || typeof manifest.dependencies !== "object") {
    throw new Error("Plugin bundle dependencies are required");
  }
  return {
    ...manifest,
    dependencies: {
      ...manifest.dependencies,
      [channelPackageName]: `file:tarballs/${archiveName}`,
    },
  };
}

export function obsoleteChannelArchives(entries, keepArchive) {
  return entries.filter((entry) => channelArchivePattern.test(entry) && entry !== keepArchive).sort();
}

export function validatePluginGitState({ branch, status, ahead, behind }) {
  if (branch !== "develop") {
    throw new Error(`oneclaw-plugins must be on develop; current branch is ${branch || "(detached)"}`);
  }
  if (status.trim()) {
    throw new Error("oneclaw-plugins has uncommitted changes; commit them before packing");
  }
  if (ahead !== 0 || behind !== 0) {
    throw new Error(`oneclaw-plugins develop must equal origin/develop (ahead=${ahead}, behind=${behind})`);
  }
}

function assertPluginRepositoryReady(pluginRepo) {
  const pluginDir = path.join(pluginRepo, "plugins", "oneclaw-channel");
  const packagePath = path.join(pluginDir, "package.json");
  if (!fs.existsSync(packagePath)) {
    throw new Error(`OneClaw Channel package not found: ${packagePath}`);
  }
  run("git", ["fetch", "origin", "develop"], pluginRepo);
  const branch = run("git", ["branch", "--show-current"], pluginRepo, { capture: true }).trim();
  const status = run("git", ["status", "--porcelain"], pluginRepo, { capture: true });
  const [ahead, behind] = run("git", ["rev-list", "--left-right", "--count", "HEAD...origin/develop"], pluginRepo, {
    capture: true,
  }).trim().split(/\s+/u).map(Number);
  validatePluginGitState({ branch, status, ahead, behind });
  return { packagePath, pluginDir };
}

function restoreBundle(snapshot) {
  fs.writeFileSync(manifestPath, snapshot.manifest);
  fs.writeFileSync(lockfilePath, snapshot.lockfile);
  fs.mkdirSync(tarballsDir, { recursive: true });
  for (const entry of fs.readdirSync(tarballsDir)) {
    if (channelArchivePattern.test(entry)) fs.rmSync(path.join(tarballsDir, entry));
  }
  for (const [entry, contents] of snapshot.archives) {
    fs.writeFileSync(path.join(tarballsDir, entry), contents);
  }
}

export function main(argv = process.argv.slice(2)) {
  const { pluginRepo } = parseArguments(argv);
  const { packagePath, pluginDir } = assertPluginRepositoryReady(pluginRepo);
  const pluginPackage = readJson(packagePath);
  if (pluginPackage.name !== channelPackageName) {
    throw new Error(`Unexpected Channel package name: ${pluginPackage.name || "(missing)"}`);
  }

  console.log(`Building ${channelPackageName}@${pluginPackage.version} from ${pluginRepo}`);
  run("node", ["scripts/validate-plugin-releases.mjs", "oneclaw-channel"], pluginRepo);
  run("corepack", ["pnpm", "test"], pluginDir);
  run("corepack", ["pnpm", "typecheck"], pluginDir);
  run("corepack", ["pnpm", "build"], pluginDir);

  const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-channel-pack-"));
  try {
    run("corepack", ["pnpm", "pack", "--pack-destination", temporaryDir], pluginDir);
    const packed = fs.readdirSync(temporaryDir).filter((entry) => entry.endsWith(".tgz"));
    if (packed.length !== 1) throw new Error(`Expected one Channel tgz, found ${packed.length}`);
    const packedPath = path.join(temporaryDir, packed[0]);
    const sha256 = createHash("sha256").update(fs.readFileSync(packedPath)).digest("hex");
    const archiveName = contentAddressedArchiveName(pluginPackage.version, sha256);
    const archivePath = path.join(tarballsDir, archiveName);

    fs.mkdirSync(tarballsDir, { recursive: true });
    const existingArchives = fs.readdirSync(tarballsDir).filter((entry) => channelArchivePattern.test(entry));
    const snapshot = {
      manifest: fs.readFileSync(manifestPath),
      lockfile: fs.readFileSync(lockfilePath),
      archives: new Map(existingArchives.map((entry) => [entry, fs.readFileSync(path.join(tarballsDir, entry))])),
    };

    try {
      fs.copyFileSync(packedPath, archivePath);
      const manifest = updateChannelDependency(readJson(manifestPath), archiveName);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      run("npm", [
        "install",
        "--package-lock-only",
        "--ignore-scripts",
        "--legacy-peer-deps",
        "--no-audit",
        "--no-fund",
      ], bundleDir);
      for (const obsolete of obsoleteChannelArchives(fs.readdirSync(tarballsDir), archiveName)) {
        fs.rmSync(path.join(tarballsDir, obsolete));
      }
      run("node", [
        "--test",
        "test/oneclaw-plugin-bundle.test.js",
        "test/verify-openclaw-plugin-bundle.test.js",
      ], repoRoot);
    } catch (error) {
      restoreBundle(snapshot);
      throw error;
    }

    console.log(`Updated Template Channel bundle: ${archiveName}`);
    console.log("Review and commit resources/openclaw-plugin-bundle before building the image.");
  } finally {
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) {
  try {
    main();
  } catch (error) {
    console.error(`[update-local-oneclaw-channel] ${error.message}`);
    process.exitCode = 1;
  }
}
