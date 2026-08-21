import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  patchOpenclawRealtimeBaseUrl,
  testing,
} from "../scripts/patch-openclaw-realtime-base-url.mjs";

function createRuntime(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-realtime-base-url-"));
  const distDir = path.join(root, "dist");
  const filePath = path.join(distDir, "realtime-voice-provider-fixture.js");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { root, distDir, filePath };
}

test("realtime patch keeps the native bridge and adds a provider base URL", (t) => {
  const fixture = createRuntime([
    testing.CONFIG_ORIGINAL,
    testing.URL_ORIGINAL,
    testing.BRIDGE_ORIGINAL,
    testing.USER_AGENT_HELPER_ORIGINAL,
    testing.WEBSOCKET_HEADERS_ORIGINAL,
  ].join("\n"));
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.equal(patchOpenclawRealtimeBaseUrl(fixture.distDir), 1);
  const patched = fs.readFileSync(fixture.filePath, "utf8");
  assert.match(patched, /configurable OpenAI-compatible realtime base URL/);
  assert.match(patched, /baseUrl: trimToUndefined\(raw\?\.baseUrl\)/);
  assert.match(patched, /cfg\.baseUrl\.replace/);
  assert.match(patched, /baseUrl: config\.baseUrl/);
  assert.match(patched, /process\.env\.ONECLAW_USER_AGENT/);
  assert.match(patched, /"User-Agent": resolveOneClawRealtimeUserAgent\(\)/);
  assert.match(patched, /OneClaw-Cloud\/1\.0/);
  assert.equal(patchOpenclawRealtimeBaseUrl(fixture.distDir), 0, "patch must be idempotent");
});

test("realtime patch fails closed when the pinned bundle changes", (t) => {
  const fixture = createRuntime("export const changedUpstream = true;\n");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  assert.throws(
    () => patchOpenclawRealtimeBaseUrl(fixture.distDir),
    /provider config anchor was not found/,
  );
});

test("Docker image applies the realtime patch to the pinned OpenClaw dist", () => {
  const dockerfile = fs.readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /scripts\/patch-openclaw-realtime-base-url\.mjs/);
  assert.match(
    dockerfile,
    /RUN node \/app\/scripts\/patch-openclaw-realtime-base-url\.mjs \/usr\/local\/lib\/node_modules\/openclaw\/dist/,
  );
});
