#!/usr/bin/env node
/**
 * Keep detached completion replies on OneClaw's durable outbound path.
 *
 * OpenClaw 2026.7.1-2 lets an inactive requester session deliver an automatic
 * final directly to its channel. OneClaw deliberately rejects that orphan
 * send because no public Run owns it. The same completion already carries a
 * stable idempotency key. Text completions use Message Tool delivery, while
 * generated media is delivered directly by the host so overlapping background
 * completions cannot be lost when a model omits the Message Tool call.
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

const GENERATED_MEDIA_DIRECT_ORIGINAL = `		const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
		if (params.expectsCompletionMessage && subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(canonicalRequesterSessionKey, requesterActivity.sessionId)) return {
			delivered: false,
			path: "none",
			reason: "requester_abandoned",
			error: "requester session abandoned after timeout"
		};
		let activeRequesterWakeFailed = false;`;

const GENERATED_MEDIA_DIRECT_PATCHED = `		const requesterActivity = resolveRequesterSessionActivity(canonicalRequesterSessionKey);
		if (params.expectsCompletionMessage && subagentAnnounceDeliveryDeps.isRequesterSessionAbandoned(canonicalRequesterSessionKey, requesterActivity.sessionId)) return {
			delivered: false,
			path: "none",
			reason: "requester_abandoned",
			error: "requester session abandoned after timeout"
		};
		const oneClawGeneratedMediaCompletion = agentMediatedCompletion && expectedMediaUrls.length > 0 && (
			deliveryTarget.channel === "oneclaw" || deliveryTarget.channel === "oneclaw-channel"
		);
		if (oneClawGeneratedMediaCompletion) {
			const generatedMediaDelivery = await deliverGeneratedMediaCompletionDirect({
				cfg,
				requesterSessionKey: canonicalRequesterSessionKey,
				directIdempotencyKey: params.directIdempotencyKey,
				deliveryTarget,
				mediaUrls: expectedMediaUrls,
				internalEvents: params.internalEvents,
				sourceTool: params.sourceTool
			});
			if (generatedMediaDelivery) return generatedMediaDelivery;
		}
		let activeRequesterWakeFailed = false;`;

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

const DELIVERY_CONTEXT_ORIGINAL = `deliveryQueueId: params.deliveryQueueId,
		onPlatformSendDispatch: params.onPlatformSendDispatch`;

const DELIVERY_CONTEXT_PATCHED = `deliveryQueueId: params.deliveryQueueId,
		deliveryIntentId: params.deliveryIntentId,
		onPlatformSendDispatch: params.onPlatformSendDispatch`;

const DELIVERY_CORE_ORIGINAL = `deliveryQueueId: params.deliveryQueueId,
		requiredUnknownSendReconciliation: params.requiredUnknownSendReconciliation`;

const DELIVERY_CORE_PATCHED = `deliveryQueueId: params.deliveryQueueId,
		deliveryIntentId: params.deliveryIntentId,
		requiredUnknownSendReconciliation: params.requiredUnknownSendReconciliation`;

const DELIVERY_QUEUE_ORIGINAL = `const wrappedParams = {
		...params,
		...exactReconciliationRequired`;

const DELIVERY_QUEUE_PATCHED = `const wrappedParams = {
		...params,
		...platformQueueId ? { deliveryIntentId: platformQueueId } : {},
		...exactReconciliationRequired`;

export function patchOneClawCompletionDeliverySource(source) {
  let patched = source;
  if (!patched.includes(PATCHED)) {
    if (!patched.includes(ORIGINAL)) {
      throw new Error(
        "[patch-openclaw-oneclaw-completion-delivery] completion policy anchor was not found; review the OpenClaw pin",
      );
    }
    patched = patched.replace(ORIGINAL, PATCHED);
  }
  if (!patched.includes(GENERATED_MEDIA_DIRECT_PATCHED)) {
    if (!patched.includes(GENERATED_MEDIA_DIRECT_ORIGINAL)) {
      throw new Error(
        "[patch-openclaw-oneclaw-completion-delivery] generated-media delivery anchor was not found; review the OpenClaw pin",
      );
    }
    patched = patched.replace(GENERATED_MEDIA_DIRECT_ORIGINAL, GENERATED_MEDIA_DIRECT_PATCHED);
  }
  return patched;
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

export function patchOneClawDeliveryIntentSource(source) {
  let patched = source;
  for (const [original, replacement, label] of [
    [DELIVERY_CONTEXT_ORIGINAL, DELIVERY_CONTEXT_PATCHED, "adapter context"],
    [DELIVERY_CORE_ORIGINAL, DELIVERY_CORE_PATCHED, "delivery core"],
    [DELIVERY_QUEUE_ORIGINAL, DELIVERY_QUEUE_PATCHED, "durable queue"],
  ]) {
    if (patched.includes(replacement)) continue;
    if (!patched.includes(original)) {
      throw new Error(
        `[patch-openclaw-oneclaw-completion-delivery] ${label} anchor was not found; review the OpenClaw pin`,
      );
    }
    patched = patched.replace(original, replacement);
  }
  return patched;
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
  const deliveryIntentCandidates = files.filter((path) => {
    const source = readFileSync(path, "utf8");
    return source.includes(DELIVERY_QUEUE_ORIGINAL) || source.includes(DELIVERY_QUEUE_PATCHED);
  });
  if (deliveryIntentCandidates.length !== 1) {
    throw new Error(
      `[patch-openclaw-oneclaw-completion-delivery] expected one compiled outbound delivery module, found ${deliveryIntentCandidates.length}`,
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
    {
      filePath: deliveryIntentCandidates[0],
      patch: patchOneClawDeliveryIntentSource,
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
