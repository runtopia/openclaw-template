#!/usr/bin/env node

import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGINAL = `const ownerOnlyCoreToolDenylist = options?.senderIsOwner === false ? [...GATEWAY_OWNER_ONLY_CORE_TOOLS] : [];
	const ownerOnlyCoreToolPolicy = ownerOnlyCoreToolDenylist.length > 0 ? { deny: ownerOnlyCoreToolDenylist } : void 0;`;

const PATCHED = `const oneClawCronControlAllowed = options?.messageProvider === "oneclaw" && options?.senderIsOwner === false;
	const ownerOnlyCoreToolDenylist = options?.senderIsOwner === false ? GATEWAY_OWNER_ONLY_CORE_TOOLS.filter((toolName) => toolName !== "cron" || !oneClawCronControlAllowed) : [];
	const ownerOnlyCoreToolPolicy = ownerOnlyCoreToolDenylist.length > 0 ? { deny: ownerOnlyCoreToolDenylist } : void 0;`;

export function patchOneClawCronAccessSource(source) {
  if (source.includes(PATCHED)) return source;
  if (!source.includes(ORIGINAL)) {
    throw new Error("[patch-openclaw-oneclaw-cron-access] owner-only tool-policy anchor was not found; review the OpenClaw pin");
  }
  return source.replace(ORIGINAL, PATCHED);
}

function javascriptFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const filePath = join(directory, name);
    const stats = lstatSync(filePath);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) files.push(...javascriptFiles(filePath));
    else if (name.endsWith(".js") || name.endsWith(".mjs")) files.push(filePath);
  }
  return files;
}

export function patchOneClawCronAccess(openClawRoot) {
  const candidates = javascriptFiles(join(openClawRoot, "dist")).filter((filePath) => {
    const source = readFileSync(filePath, "utf8");
    return source.includes(ORIGINAL) || source.includes(PATCHED);
  });
  if (candidates.length !== 1) {
    throw new Error(`[patch-openclaw-oneclaw-cron-access] expected one compiled agent-tools module, found ${candidates.length}`);
  }
  const filePath = candidates[0];
  const source = readFileSync(filePath, "utf8");
  const patched = patchOneClawCronAccessSource(source);
  if (patched === source) return false;
  writeFileSync(filePath, patched, "utf8");
  console.log(`[patch-openclaw-oneclaw-cron-access] Patched: ${filePath}`);
  return true;
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) patchOneClawCronAccess(process.argv[2]);
