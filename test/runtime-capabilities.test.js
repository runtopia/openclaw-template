import assert from "node:assert/strict";
import test from "node:test";

import { buildRuntimeCapabilities } from "../scripts/write-runtime-capabilities.mjs";

test("standard runtime declares common document skills", () => {
  const manifest = buildRuntimeCapabilities("standard", {
    IMAGE_VERSION: "2026.7.1-standard",
    OPENCLAW_VERSION: "2026.7.1-2",
  });

  assert.equal(manifest.profile, "standard");
  assert.equal(manifest.image_version, "2026.7.1-standard");
  assert.ok(manifest.supported_skills.includes("pdf"));
  assert.ok(manifest.supported_skills.includes("manage-message-channels"));
  assert.ok(!manifest.supported_skills.includes("coding-agent"));
  assert.match(manifest.capability_digest, /^sha256:[a-f0-9]{64}$/);
});

test("full runtime is additive and has a different capability digest", () => {
  const env = { IMAGE_VERSION: "2026.7.1", OPENCLAW_VERSION: "2026.7.1-2" };
  const standard = buildRuntimeCapabilities("standard", env);
  const full = buildRuntimeCapabilities("full", env);

  assert.ok(full.supported_skills.includes("coding-agent"));
  assert.ok(full.capabilities.includes("browser-automation"));
  assert.notEqual(full.capability_digest, standard.capability_digest);
});

test("standard browser image advertises automation and live preview", () => {
  const manifest = buildRuntimeCapabilities("standard", { ONECLAW_BROWSER_ENABLED: "1" });
  assert.ok(manifest.capabilities.includes("browser-automation"));
  assert.ok(manifest.capabilities.includes("browser-live-preview"));
});

test("Browser Use enabled images advertise the plugin-bundled skill", () => {
  const manifest = buildRuntimeCapabilities("standard", { ONECLAW_BROWSER_ENABLED: "1", ONECLAW_BROWSER_USE_ENABLED: "1" });
  assert.ok(manifest.supported_skills.includes("browser-use"));
});
