import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  patchOneClawCompletionDelivery,
  patchOneClawCompletionDeliverySource,
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

test("OneClaw completion delivery patch skips bundled plugin symlink loops", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oneclaw-completion-patch-"));
  const dist = path.join(root, "dist");
  const pluginModules = path.join(dist, "extensions", "oneclaw-channel", "node_modules");
  mkdirSync(pluginModules, { recursive: true });
  writeFileSync(path.join(dist, "completion.mjs"), fixture);
  symlinkSync(root, path.join(pluginModules, "openclaw"));

  try {
    assert.equal(patchOneClawCompletionDelivery(root), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OneClaw completion delivery patch fails closed when the host changes", () => {
  assert.throws(
    () => patchOneClawCompletionDeliverySource("const changed = true;"),
    /completion policy anchor was not found/,
  );
});
