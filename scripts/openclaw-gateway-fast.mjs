#!/usr/bin/env node

// OneClaw's image already generates and validates the exact pinned OpenClaw
// config before Gateway launch. Calling the internal run command directly
// avoids repeating the generic CLI environment selection, Doctor, and
// migration bootstrap on every container start. This is deliberately pinned
// to one verified host build and falls back to the public CLI on any drift.

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const SUPPORTED_OPENCLAW_VERSION = "2026.7.1-2";

const VALUE_OPTIONS = new Map([
  ["--port", "port"],
  ["--bind", "bind"],
  ["--token", "token"],
  ["--auth", "auth"],
  ["--password", "password"],
  ["--password-file", "passwordFile"],
  ["--tailscale", "tailscale"],
  ["--ws-log", "wsLog"],
  ["--raw-stream-path", "rawStreamPath"],
]);

const BOOLEAN_OPTIONS = new Map([
  ["--tailscale-reset-on-exit", "tailscaleResetOnExit"],
  ["--allow-unconfigured", "allowUnconfigured"],
  ["--dev", "dev"],
  ["--reset", "reset"],
  ["--force", "force"],
  ["--verbose", "verbose"],
  ["--cli-backend-logs", "cliBackendLogs"],
  ["--claude-cli-logs", "claudeCliLogs"],
  ["--compact", "compact"],
  ["--raw-stream", "rawStream"],
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function resolveOpenClawLayout({
  entryPath = process.env.OPENCLAW_ENTRY || "/usr/local/lib/node_modules/openclaw/dist/entry.js",
  supportedVersion = SUPPORTED_OPENCLAW_VERSION,
} = {}) {
  const cleanEntry = path.resolve(String(entryPath).trim());
  const distDir = path.dirname(cleanEntry);
  const packageRoot = path.dirname(distDir);
  const packageJsonPath = path.join(packageRoot, "package.json");

  if (!fs.existsSync(cleanEntry)) throw new Error(`OpenClaw entry not found: ${cleanEntry}`);
  const pkg = readJson(packageJsonPath);
  if (pkg.name !== "openclaw") throw new Error(`unexpected Gateway package: ${pkg.name || "unknown"}`);
  if (pkg.version !== supportedVersion) {
    throw new Error(`OpenClaw ${pkg.version || "unknown"} is not validated for fast boot (expected ${supportedVersion})`);
  }

  const candidates = fs.readdirSync(distDir)
    .filter((name) => /^run-[A-Za-z0-9_-]+\.js$/.test(name))
    .map((name) => path.join(distDir, name))
    .filter((filePath) => fs.readFileSync(filePath, "utf8").includes("export { runGatewayCommand };"));
  if (candidates.length !== 1) {
    throw new Error(`expected one runGatewayCommand module, found ${candidates.length}`);
  }

  return {
    entryPath: cleanEntry,
    packageRoot,
    version: pkg.version,
    runModulePath: candidates[0],
  };
}

export function parseGatewayRunArgs(argv) {
  const args = [...argv];
  if (args[0] === "gateway" && args[1] === "run") args.splice(0, 2);
  else throw new Error("fast Gateway entry only supports `gateway run`");

  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const valueKey = VALUE_OPTIONS.get(flag);
    if (valueKey) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`missing value for ${flag}`);
      options[valueKey] = value;
      index += 1;
      continue;
    }
    const booleanKey = BOOLEAN_OPTIONS.get(flag);
    if (booleanKey) {
      options[booleanKey] = true;
      continue;
    }
    throw new Error(`unsupported Gateway option: ${flag}`);
  }
  return options;
}

function forwardFallbackSignals(proc) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      try { proc.kill(signal); } catch {}
    });
  }
}

export function runPublicCli(entryPath, argv) {
  console.warn("[fast-gateway] using standard OpenClaw CLI fallback");
  const proc = childProcess.spawn(process.execPath, [entryPath, ...argv], {
    stdio: "inherit",
    env: process.env,
  });
  forwardFallbackSignals(proc);
  proc.once("error", (err) => {
    console.error(`[fast-gateway] CLI fallback spawn failed: ${err.message}`);
    process.exitCode = 1;
  });
  proc.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

export async function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.length === 1 && argv[0] === "--check";
  const entryPath = process.env.OPENCLAW_ENTRY || "/usr/local/lib/node_modules/openclaw/dist/entry.js";
  let layout;
  let options;
  let runGatewayCommand;
  try {
    layout = resolveOpenClawLayout({ entryPath });
    if (!checkOnly) options = parseGatewayRunArgs(argv);
    const imported = await import(pathToFileURL(layout.runModulePath).href);
    if (typeof imported.runGatewayCommand !== "function") {
      throw new Error("runGatewayCommand export is unavailable");
    }
    runGatewayCommand = imported.runGatewayCommand;
    if (checkOnly) {
      console.log(`[fast-gateway] validated OpenClaw ${layout.version}`);
      return;
    }
  } catch (err) {
    if (checkOnly) throw err;
    console.warn(`[fast-gateway] preflight failed: ${err.message}`);
    runPublicCli(entryPath, argv);
    return;
  }

  console.log(`[fast-gateway] OpenClaw ${layout.version}; bypassing generic CLI bootstrap`);
  // From this point onward, never launch a fallback process. A failure may
  // have already acquired the Gateway lock or bound the port; the wrapper's
  // existing crash recovery is the safe owner of retries.
  await runGatewayCommand(options);
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`[fast-gateway] ${err.message}`);
    process.exitCode = 1;
  });
}
