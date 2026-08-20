import assert from "node:assert/strict";
import test from "node:test";

import { patchOpenClawAssistantMediaAgentRootsSource } from "../scripts/patch-openclaw-assistant-media-agent-roots.js";

const fixture = `
const url = new URL(urlRaw, "http://localhost");
const localRoots = opts?.config ? getAgentScopedMediaLocalRoots(opts.config, opts.agentId) : getDefaultLocalRoots();
await assertLocalMediaAllowed(localPath, localRoots);
`;

test("assistant-media resolves roots for an authenticated requested agent", () => {
  const patched = patchOpenClawAssistantMediaAgentRootsSource(fixture);
  assert.match(patched, /url\.searchParams\.get\("agentId"\)\?\.trim\(\) \|\| opts\?\.agentId/);
  assert.match(patched, /getAgentScopedMediaLocalRoots\(opts\.config, requestedAgentId\)/);
  assert.doesNotMatch(patched, /getAgentScopedMediaLocalRoots\(opts\.config, opts\.agentId\)/);
});

test("assistant-media agent-root patch is idempotent", () => {
  const once = patchOpenClawAssistantMediaAgentRootsSource(fixture);
  assert.equal(patchOpenClawAssistantMediaAgentRootsSource(once), once);
});
