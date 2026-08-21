// Direct openclaw.json patcher.
//
// Why this exists:
//   `openclaw config set <key> <value>` spawns a fresh node process that
//   loads the entire openclaw CLI (~3-5s cold start). The wrapper post-onboard
//   flow used to issue 10+ such calls back-to-back, each one paying the
//   startup cost. Total: 30-60s of pure subprocess overhead.
//
//   Reading openclaw.json once, mutating the in-memory object, and writing
//   it back drops that to a few ms. OpenClaw watches the file for changes
//   and hot-reloads, so the effect is the same.
//
// Use a single patchConfig() per logical setup step so the file only writes
// once — fewer hot-reload events for the gateway.

import fs from "node:fs";
import path from "node:path";

function writeConfigIfChanged(configPath, previous, next) {
  if (previous === next) return false;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const mode = fs.existsSync(configPath) ? fs.statSync(configPath).mode : 0o600;
    fs.writeFileSync(temporary, next, { encoding: "utf8", mode });
    fs.renameSync(temporary, configPath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
  return true;
}

export function patchConfig(configPath, patcher) {
  const previous = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  const config = previous ? JSON.parse(previous) : {};
  patcher(config);
  writeConfigIfChanged(configPath, previous, JSON.stringify(config, null, 2));
  fs.chmodSync(configPath, 0o600);
  return config;
}

export function setIn(obj, dotPath, value) {
  const parts = dotPath.split(".");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] == null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

export function mergeIn(obj, dotPath, partial) {
  const parts = dotPath.split(".");
  let cursor = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cursor[key] == null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  const last = parts[parts.length - 1];
  const existing = (cursor[last] && typeof cursor[last] === "object") ? cursor[last] : {};
  cursor[last] = { ...existing, ...partial };
}
