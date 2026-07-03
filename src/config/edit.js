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

export function patchConfig(configPath, patcher) {
  const config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  patcher(config);
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
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
