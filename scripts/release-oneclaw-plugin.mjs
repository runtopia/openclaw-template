#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInstallArgs, verifyUpdatedBundle } from "./update-oneclaw-plugins.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = path.join(repoRoot, "resources", "openclaw-plugin-bundle");
const manifestPath = path.join(bundleDir, "package.json");
const lockfilePath = path.join(bundleDir, "package-lock.json");
const tarballsDir = path.join(bundleDir, "tarballs");
const registry = (
  process.env.ONECLAW_NPM_REGISTRY?.trim() || "https://registry.npmjs.org"
).replace(/\/+$/u, "");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const templateTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

function run(command, args, cwd, options = {}) {
  const output = execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return options.trim === false ? output ?? "" : output?.trim() ?? "";
}

function git(args, cwd, options = {}) {
  return run("git", args, cwd, options);
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

export function parseArguments(argv, templateRoot = repoRoot, env = process.env) {
  let pluginId;
  let templateTag;
  let pluginRepo = env.ONECLAW_PLUGINS_REPO?.trim();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--") && !pluginId) {
      pluginId = argument;
      continue;
    }
    if (argument === "--tag") {
      templateTag = argv[index + 1]?.trim();
      if (!templateTag) throw new Error("--tag requires v<major>.<minor>.<patch>");
      index += 1;
      continue;
    }
    if (argument === "--plugin-repo") {
      pluginRepo = argv[index + 1]?.trim();
      if (!pluginRepo) throw new Error("--plugin-repo requires a path");
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!pluginId || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(pluginId)) {
    throw new Error("usage: npm run release:oneclaw-plugin -- <plugin-id> [--tag vX.Y.Z] [--plugin-repo PATH]");
  }
  if (templateTag && !templateTagPattern.test(templateTag)) {
    throw new Error(`Invalid Template release tag: ${templateTag}`);
  }
  return {
    pluginId,
    templateTag: templateTag || null,
    pluginRepo: path.resolve(templateRoot, pluginRepo || "../oneclaw-plugins"),
  };
}

export function validateRepositoryState(name, { branch, status, ahead, behind }) {
  if (branch !== "main") {
    throw new Error(`${name} must be on main; current branch is ${branch || "(detached)"}`);
  }
  if (status.trim()) throw new Error(`${name} has uncommitted changes; commit them before releasing`);
  if (ahead !== 0 || behind !== 0) {
    throw new Error(`${name} main must equal origin/main (ahead=${ahead}, behind=${behind})`);
  }
}

export function nextTemplateTag(tags) {
  const versions = tags
    .map((tag) => ({ tag, match: tag.match(templateTagPattern) }))
    .filter(({ match }) => match)
    .map(({ match }) => match.slice(1, 4).map(Number))
    .sort((left, right) => (
      left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
    ));
  if (versions.length === 0) throw new Error("No stable Template vX.Y.Z tag exists");
  const [major, minor, patchVersion] = versions.at(-1);
  return `v${major}.${minor}.${patchVersion + 1}`;
}

export function directReleaseDependencies(manifest, release) {
  const dependencies = manifest.dependencies || {};
  const updates = (release.artifacts || [])
    .filter((artifact) => Object.hasOwn(dependencies, artifact.package))
    .map((artifact) => ({
      packageName: artifact.package,
      currentVersion: dependencies[artifact.package],
      latestVersion: artifact.version,
    }));
  if (!updates.some(({ packageName }) => packageName === release.plugin?.package)) {
    throw new Error(`${release.plugin?.package || "released plugin"} is not declared in the Template bundle`);
  }
  return updates;
}

export function unreferencedTarballs(entries, manifest) {
  const referenced = new Set(
    Object.values(manifest.dependencies || {})
      .filter((spec) => typeof spec === "string" && spec.startsWith("file:tarballs/"))
      .map((spec) => spec.slice("file:tarballs/".length)),
  );
  return entries.filter((entry) => entry.endsWith(".tgz") && !referenced.has(entry)).sort();
}

export function porcelainPaths(status) {
  return status
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3));
}

function assertRepositoryReady(name, repository) {
  git(["fetch", "origin", "main", "--tags"], repository);
  const branch = git(["branch", "--show-current"], repository, { capture: true });
  const status = git(["status", "--porcelain"], repository, { capture: true });
  const [ahead, behind] = git(
    ["rev-list", "--left-right", "--count", "HEAD...origin/main"],
    repository,
    { capture: true },
  ).split(/\s+/u).map(Number);
  validateRepositoryState(name, { branch, status, ahead, behind });
}

function remoteTagExists(tag) {
  const result = spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) return true;
  if (result.status === 2) return false;
  throw new Error(result.stderr.trim() || `Failed to inspect origin tag ${tag}`);
}

function npmVersion(packageName, version) {
  const result = spawnSync(
    "npm",
    ["view", `${packageName}@${version}`, "version", "--json", `--registry=${registry}`],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    const value = Array.isArray(parsed) ? parsed.at(-1) : parsed;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

async function waitForNpmPackages(release) {
  const timeoutMs = Number(process.env.ONECLAW_NPM_WAIT_MS || 15 * 60 * 1000);
  const packages = (release.artifacts || []).map(({ package: packageName, version }) => ({ packageName, version }));
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const missing = packages.filter(({ packageName, version }) => npmVersion(packageName, version) !== version);
    if (missing.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`npm publication timed out: ${missing.map(({ packageName, version }) => `${packageName}@${version}`).join(", ")}`);
    }
    console.log(`Waiting for npm: ${missing.map(({ packageName, version }) => `${packageName}@${version}`).join(", ")}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10_000));
  }
}

function ensureAllowedTemplateChanges() {
  const changed = porcelainPaths(git(["status", "--porcelain"], repoRoot, { capture: true, trim: false }));
  const unexpected = changed.filter((filename) => !filename.startsWith("resources/openclaw-plugin-bundle/"));
  if (unexpected.length > 0) throw new Error(`Unexpected Template release changes: ${unexpected.join(", ")}`);
  return changed;
}

export async function main(argv = process.argv.slice(2)) {
  const { pluginId, templateTag: requestedTag, pluginRepo } = parseArguments(argv);
  assertRepositoryReady("openclaw-template", repoRoot);
  assertRepositoryReady("oneclaw-plugins", pluginRepo);

  const releasePath = path.join(pluginRepo, "plugins", pluginId, "oneclaw.release.json");
  if (!fs.existsSync(releasePath)) throw new Error(`Plugin release metadata not found: ${releasePath}`);
  const release = readJson(releasePath);
  if (!versionPattern.test(release.plugin?.version || "")) throw new Error(`${pluginId}: invalid release version`);

  const tag = requestedTag || nextTemplateTag(
    git(["tag", "--list", "v*", "--merged", "origin/main"], repoRoot, { capture: true }).split("\n").filter(Boolean),
  );
  if (remoteTagExists(tag)) throw new Error(`Template release tag already exists: ${tag}`);

  console.log(`Publishing ${release.plugin.tag} from committed oneclaw-plugins main...`);
  run("corepack", ["pnpm", "release", pluginId], pluginRepo);
  await waitForNpmPackages(release);

  const manifest = readJson(manifestPath);
  const updates = directReleaseDependencies(manifest, release);
  run("npm", buildInstallArgs(updates, registry), bundleDir);
  const updatedManifest = readJson(manifestPath);
  for (const archive of unreferencedTarballs(fs.readdirSync(tarballsDir), updatedManifest)) {
    fs.rmSync(path.join(tarballsDir, archive));
  }
  verifyUpdatedBundle(
    updatedManifest,
    readJson(lockfilePath),
    Object.fromEntries(updates.map(({ packageName, latestVersion }) => [packageName, latestVersion])),
  );
  run("npm", ["test"], repoRoot);

  const changed = ensureAllowedTemplateChanges();
  if (changed.length > 0) {
    git(["add", "resources/openclaw-plugin-bundle"], repoRoot);
    git(["commit", "-m", `chore: pin ${release.plugin.package}@${release.plugin.version}`], repoRoot);
  } else {
    console.log(`${release.plugin.package}@${release.plugin.version} is already pinned; tagging current main`);
  }

  const head = git(["rev-parse", "HEAD"], repoRoot, { capture: true });
  git(["tag", "--annotate", tag, "--message", `Release ${tag}`], repoRoot);
  try {
    git(["push", "origin", "main"], repoRoot);
    git(["push", "origin", `refs/tags/${tag}`], repoRoot);
  } catch (error) {
    if (git(["rev-list", "--max-count=1", tag], repoRoot, { capture: true }) === head) {
      git(["tag", "--delete", tag], repoRoot);
    }
    throw error;
  }
  console.log(`Released ${release.plugin.package}@${release.plugin.version} in Template ${tag}`);
}

const isCLI = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCLI) {
  main().catch((error) => {
    console.error(`[release-oneclaw-plugin] ${error.message}`);
    process.exitCode = 1;
  });
}
