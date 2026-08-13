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

import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

const INTERNAL_SOURCE_REPLY_ORIGINAL = `function hasExternalSessionDeliveryRoute(sessionKey) {
	const route = parseSessionDeliveryRoute(sessionKey);
	if (!route) return false;
	const channel = normalizeMessageChannel(route.channel);
	return Boolean(channel && channel !== "webchat");
}`;

const INTERNAL_SOURCE_REPLY_PATCHED = `function hasExternalSessionDeliveryRoute(sessionKey) {
	const route = parseSessionDeliveryRoute(sessionKey);
	if (!route) return false;
	const channel = normalizeMessageChannel(route.channel) ?? normalizeOptionalLowercaseString(route.channel);
	return Boolean(channel && channel !== "webchat");
}`;

export function patchOneClawCompletionDeliverySource(source) {
  if (source.includes(PATCHED)) return source;
  if (!source.includes(ORIGINAL)) {
    throw new Error(
      "[patch-openclaw-oneclaw-completion-delivery] completion policy anchor was not found; review the OpenClaw pin",
    );
  }
  return source.replace(ORIGINAL, PATCHED);
}

export function patchOneClawInternalSourceReplySource(source) {
  if (source.includes(INTERNAL_SOURCE_REPLY_PATCHED)) return source;
  if (!source.includes(INTERNAL_SOURCE_REPLY_ORIGINAL)) {
    throw new Error(
      "[patch-openclaw-oneclaw-completion-delivery] internal source-reply anchor was not found; review the OpenClaw pin",
    );
  }
  return source.replace(INTERNAL_SOURCE_REPLY_ORIGINAL, INTERNAL_SOURCE_REPLY_PATCHED);
}

function javascriptFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory()) {
      files.push(...javascriptFiles(path));
    } else if (name.endsWith(".js") || name.endsWith(".mjs")) {
      files.push(path);
    }
  }
  return files;
}

export function patchOneClawCompletionDelivery(openClawRoot) {
  const dist = join(openClawRoot, "dist");
  const files = javascriptFiles(dist);
  const completionCandidates = files.filter((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes(ORIGINAL) || source.includes(PATCHED);
  });
  if (completionCandidates.length !== 1) {
    throw new Error(
      `[patch-openclaw-oneclaw-completion-delivery] expected one compiled completion module, found ${completionCandidates.length}`,
    );
  }
  const internalSourceReplyCandidates = files.filter((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes(INTERNAL_SOURCE_REPLY_ORIGINAL) || source.includes(INTERNAL_SOURCE_REPLY_PATCHED);
  });
  if (internalSourceReplyCandidates.length !== 1) {
    throw new Error(
      `[patch-openclaw-oneclaw-completion-delivery] expected one compiled internal source-reply module, found ${internalSourceReplyCandidates.length}`,
    );
  }

  const patches = [
    {
      filePath: completionCandidates[0],
      patch: patchOneClawCompletionDeliverySource,
    },
    {
      filePath: internalSourceReplyCandidates[0],
      patch: patchOneClawInternalSourceReplySource,
    },
  ];
  let changed = false;
  for (const entry of patches) {
    const source = readFileSync(entry.filePath, "utf8");
    const patched = entry.patch(source);
    if (patched === source) continue;
    writeFileSync(entry.filePath, patched, "utf8");
    console.log(`[patch-openclaw-oneclaw-completion-delivery] Patched: ${entry.filePath}`);
    changed = true;
  }
  return changed;
}

const isCli = process.argv[1]
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) patchOneClawCompletionDelivery(process.argv[2]);
