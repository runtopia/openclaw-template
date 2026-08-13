import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  patchOneClawCompletionDelivery,
  patchOneClawCompletionDeliverySource,
  patchOneClawInternalSourceReplySource,
} from "../scripts/patch-openclaw-oneclaw-completion-delivery.mjs";

const fixture = `
const completionRouteRequiresMessageToolDelivery = params.expectsCompletionMessage && completionRequiresMessageToolDelivery({
			cfg,
			requesterSessionKey: params.requesterSessionKey,
			targetRequesterSessionKey: canonicalRequesterSessionKey,
			requesterEntry,
			directOrigin: effectiveDirectOrigin,
			requesterSessionOrigin
		});
`;

const internalSourceReplyFixture = `
function hasExternalSessionDeliveryRoute(sessionKey) {
	const route = parseSessionDeliveryRoute(sessionKey);
	if (!route) return false;
	const channel = normalizeMessageChannel(route.channel);
	return Boolean(channel && channel !== "webchat");
}
`;

const messageToolDeliveryFixture = `
function inferDeliveryFromSessionKey(sessionKey) {
	const route = parseSessionDeliveryRoute(sessionKey);
	if (!route) return null;
	const channel = normalizeMessageChannel(route.channel);
	if (!channel) return null;
	return { channel };
}
`;

test("OneClaw detached completions require durable Message Tool delivery", () => {
  const patched = patchOneClawCompletionDeliverySource(fixture);

  assert.match(patched, /deliveryTarget\.channel === "oneclaw"/);
  assert.match(patched, /deliveryTarget\.channel === "oneclaw-channel"/);
  assert.doesNotThrow(() => new Function(
    "params",
    "completionRequiresMessageToolDelivery",
    "deliveryTarget",
    "cfg",
    "canonicalRequesterSessionKey",
    "requesterEntry",
    "effectiveDirectOrigin",
    "requesterSessionOrigin",
    `${patched}; return completionRouteRequiresMessageToolDelivery;`,
  ));
});

test("OneClaw completion delivery patch is idempotent", () => {
  const once = patchOneClawCompletionDeliverySource(fixture);
  assert.equal(patchOneClawCompletionDeliverySource(once), once);
});

test("OneClaw message-tool completion bypasses the private internal-ui sink", () => {
  const patched = patchOneClawInternalSourceReplySource(internalSourceReplyFixture);

  assert.match(patched, /normalizeOptionalLowercaseString\(route\.channel\)/);
  const hasExternalSessionDeliveryRoute = new Function(
    "parseSessionDeliveryRoute",
    "normalizeMessageChannel",
    "normalizeOptionalLowercaseString",
    `${patched}; return hasExternalSessionDeliveryRoute;`,
  )(
    (sessionKey) => {
      const match = sessionKey?.match(/^agent:[^:]+:([^:]+):direct:/u);
      return match ? { channel: match[1] } : undefined;
    },
    (value) => value === "webchat" ? "webchat" : undefined,
    (value) => value?.trim().toLowerCase(),
  );
  assert.equal(hasExternalSessionDeliveryRoute("agent:main:oneclaw:direct:session_123"), true);
  assert.equal(hasExternalSessionDeliveryRoute("agent:main:webchat:direct:session_123"), false);
  assert.equal(hasExternalSessionDeliveryRoute("agent:main:main"), false);
});

test("OneClaw internal source-reply patch is idempotent", () => {
  const once = patchOneClawInternalSourceReplySource(internalSourceReplyFixture);
  assert.equal(patchOneClawInternalSourceReplySource(once), once);
});

test("OneClaw completion delivery patch skips bundled plugin symlink loops", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oneclaw-completion-patch-"));
  const dist = path.join(root, "dist");
  const pluginModules = path.join(dist, "extensions", "oneclaw-channel", "node_modules");
  mkdirSync(pluginModules, { recursive: true });
  writeFileSync(path.join(dist, "completion.mjs"), fixture);
  writeFileSync(path.join(dist, "internal-source-reply.mjs"), internalSourceReplyFixture);
  writeFileSync(path.join(dist, "openclaw-tools.mjs"), messageToolDeliveryFixture);
  symlinkSync(root, path.join(pluginModules, "openclaw"));

  try {
    assert.equal(patchOneClawCompletionDelivery(root), true);
    assert.equal(
      readFileSync(path.join(dist, "openclaw-tools.mjs"), "utf8"),
      messageToolDeliveryFixture,
      "the similarly shaped Message Tool bundle must not be patched",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OneClaw completion delivery patch fails closed when the host changes", () => {
  assert.throws(
    () => patchOneClawCompletionDeliverySource("const changed = true;"),
    /completion policy anchor was not found/,
  );
  assert.throws(
    () => patchOneClawInternalSourceReplySource("const changed = true;"),
    /internal source-reply anchor was not found/,
  );
});
