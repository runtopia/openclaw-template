#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(repoRoot, "resources", "openclaw-plugin-bundle");
const manifestPath = path.join(bundleDir, "package.json");
const lockfilePath = path.join(bundleDir, "package-lock.json");
const registry = (
  process.env.ONECLAW_NPM_REGISTRY?.trim() || "https://registry.npmjs.org"
).replace(/\/+$/u, "");
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function getOneclawDependencies(manifest) {
  return Object.entries(manifest.dependencies || {})
    .filter(([packageName]) => packageName.startsWith("@oneclaw-plugins/"))
    .sort(([left], [right]) => left.localeCompare(right));
}

export function detectUpdates(currentDependencies, latestVersions) {
  return currentDependencies
    .map(([packageName, currentVersion]) => ({
      packageName,
      currentVersion,
      latestVersion: latestVersions[packageName],
    }))
    .filter(({ currentVersion, latestVersion }) => currentVersion !== latestVersion);
}

export function buildInstallArgs(updates, npmRegistry = registry) {
  return [
    "install",
    "--package-lock-only",
    "--save-exact",
    "--ignore-scripts",
    "--legacy-peer-deps",
    "--no-audit",
    "--no-fund",
    `--registry=${npmRegistry}`,
    ...updates.map(({ packageName, latestVersion }) => `${packageName}@${latestVersion}`),
  ];
}

export function verifyUpdatedBundle(manifest, lockfile, latestVersions) {
  const errors = [];
  for (const [packageName, latestVersion] of Object.entries(latestVersions)) {
    if (manifest.dependencies?.[packageName] !== latestVersion) {
      errors.push(`${packageName}: package.json is not pinned to ${latestVersion}`);
    }
    const lockRootVersion = lockfile.packages?.[""]?.dependencies?.[packageName];
    if (lockRootVersion !== latestVersion) {
      errors.push(`${packageName}: package-lock.json root is not pinned to ${latestVersion}`);
    }
    const entry = lockfile.packages?.[`node_modules/${packageName}`];
    if (entry?.version !== latestVersion) {
      errors.push(`${packageName}: package-lock.json entry is not ${latestVersion}`);
    }
    if (!entry?.integrity?.startsWith("sha512-")) {
      errors.push(`${packageName}: package-lock.json entry has no sha512 integrity`);
    }
    if (!entry?.resolved?.startsWith(`${registry}/`)) {
      errors.push(`${packageName}: package-lock.json entry is not resolved from ${registry}`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join("\n"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function queryLatestVersion(packageName) {
  const output = execFileSync(
    "npm",
    ["view", packageName, "dist-tags.latest", "--json", `--registry=${registry}`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  ).trim();
  const version = JSON.parse(output);
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`${packageName}: npm returned an invalid latest version: ${output}`);
  }
  return version;
}

function printUpdates(updates) {
  for (const { packageName, currentVersion, latestVersion } of updates) {
    console.log(`  ${packageName}: ${currentVersion} -> ${latestVersion}`);
  }
}

export function main(argv = process.argv.slice(2)) {
  const unknownArgs = argv.filter((arg) => arg !== "--check");
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown argument: ${unknownArgs.join(", ")}`);
  }
  const checkOnly = argv.includes("--check");
  const manifest = readJson(manifestPath);
  const dependencies = getOneclawDependencies(manifest);
  if (dependencies.length === 0) throw new Error("No @oneclaw-plugins/* dependencies found");

  console.log(`Checking ${dependencies.length} OneClaw plugins via ${registry}...`);
  const latestVersions = Object.fromEntries(
    dependencies.map(([packageName]) => [packageName, queryLatestVersion(packageName)]),
  );
  const updates = detectUpdates(dependencies, latestVersions);

  if (updates.length === 0) {
    console.log("All OneClaw plugins are already up to date.");
    return;
  }

  console.log(`${updates.length} OneClaw plugin update(s) available:`);
  printUpdates(updates);
  if (checkOnly) {
    process.exitCode = 1;
    return;
  }

  execFileSync("npm", buildInstallArgs(updates), { cwd: bundleDir, stdio: "inherit" });
  verifyUpdatedBundle(readJson(manifestPath), readJson(lockfilePath), latestVersions);
  console.log("Updated package.json and package-lock.json to the latest exact versions.");
  console.log("Run `npm test` before building and deploying the image.");
}

const isCli = process.argv[1]
  && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  try {
    main();
  } catch (error) {
    console.error(`[update-oneclaw-plugins] ${error.message}`);
    process.exitCode = 1;
  }
}
