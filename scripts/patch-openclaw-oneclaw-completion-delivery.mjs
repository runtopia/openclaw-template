#!/usr/bin/env node
/**
 * Keep detached completion replies on OneClaw's durable Message Tool path.
 *
 * OpenClaw 2026.7.1-2 lets an inactive requester session deliver an automatic
 * final directly to its channel. OneClaw deliberately rejects that orphan
 * send because no public Run owns it. The same completion already carries a
 * stable idempotency key; forcing Message Tool delivery lets oneclaw-channel
 * allocate the autonomous public Run and persist generated media exactly once.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ORIGINAL = `const completionRouteRequiresMessageToolDelivery = params.expectsCompletionMessage && completionRequiresMessageToolDelivery({
			cfg,
			requesterSessionKey: params.requesterSessionKey,
			targetRequesterSessionKey: canonicalRequesterSessionKey,
			requesterEntry,
			directOrigin: effectiveDirectOrigin,
			requesterSessionOrigin
		});`;

const PATCHED = `const completionRouteRequiresMessageToolDelivery = params.expectsCompletionMessage && (
			deliveryTarget.channel === "oneclaw" ||
			deliveryTarget.channel === "oneclaw-channel" ||
			completionRequiresMessageToolDelivery({
				cfg,
				requesterSessionKey: params.requesterSessionKey,
				targetRequesterSessionKey: canonicalRequesterSessionKey,
				requesterEntry,
				directOrigin: effectiveDirectOrigin,
				requesterSessionOrigin
			})
		);`;

export function patchOneClawCompletionDeliverySource(source) {
  if (source.includes(PATCHED)) return source;
  if (!source.includes(ORIGINAL)) {
    throw new Error(
      "[patch-openclaw-oneclaw-completion-delivery] completion policy anchor was not found; review the OpenClaw pin",
    );
  }
  return source.replace(ORIGINAL, PATCHED);
}

function javascriptFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      files.push(...javascriptFiles(path));
    } else if (name.endsWith(".js") || name.endsWith(".mjs")) {
      files.push(path);
    }
  }
  return files;
}

export function patchOneClawCompletionDelivery(openClawRoot) {
  const dist = join(openClawRoot, "dist");
  const candidates = javascriptFiles(dist).filter((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes(ORIGINAL) || source.includes(PATCHED);
  });
  if (candidates.length !== 1) {
    throw new Error(
      `[patch-openclaw-oneclaw-completion-delivery] expected one compiled completion module, found ${candidates.length}`,
    );
  }
  const filePath = candidates[0];
  const source = readFileSync(filePath, "utf8");
  const patched = patchOneClawCompletionDeliverySource(source);
  if (patched === source) return false;
  writeFileSync(filePath, patched, "utf8");
  console.log(`[patch-openclaw-oneclaw-completion-delivery] Patched: ${filePath}`);
  return true;
}

const isCli = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) patchOneClawCompletionDelivery(process.argv[2]);
