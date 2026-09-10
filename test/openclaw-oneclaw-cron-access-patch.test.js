import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  patchOneClawCronAccess,
  patchOneClawCronAccessSource,
} from "../scripts/patch-openclaw-oneclaw-cron-access.mjs";

const fixture = `
const ownerOnlyCoreToolDenylist = options?.senderIsOwner === false ? [...GATEWAY_OWNER_ONLY_CORE_TOOLS] : [];
	const ownerOnlyCoreToolPolicy = ownerOnlyCoreToolDenylist.length > 0 ? { deny: ownerOnlyCoreToolDenylist } : void 0;
`;

test("authenticated OneClaw turns expose Cron without exposing other owner-only tools", () => {
  const patched = patchOneClawCronAccessSource(fixture);
  const resolveDenied = new Function(
    "options",
    "GATEWAY_OWNER_ONLY_CORE_TOOLS",
    `${patched}; return ownerOnlyCoreToolDenylist;`,
  );

  assert.deepEqual(resolveDenied({ senderIsOwner: false, messageProvider: "oneclaw" }, ["cron", "gateway", "nodes"]), ["gateway", "nodes"]);
  assert.deepEqual(resolveDenied({ senderIsOwner: false, messageProvider: "telegram" }, ["cron", "gateway", "nodes"]), ["cron", "gateway", "nodes"]);
  assert.deepEqual(resolveDenied({ senderIsOwner: true, messageProvider: "oneclaw" }, ["cron", "gateway", "nodes"]), []);
  assert.equal(patchOneClawCronAccessSource(patched), patched);
});

test("OneClaw Cron access patch updates exactly one compiled module", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "oneclaw-cron-access-"));
  const dist = path.join(root, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(path.join(dist, "agent-tools.js"), fixture);
  try {
    assert.equal(patchOneClawCronAccess(root), true);
    assert.equal(patchOneClawCronAccess(root), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("OneClaw Cron access patch fails closed when the host changes", () => {
  assert.throws(() => patchOneClawCronAccessSource("const changed = true;"), /anchor was not found/u);
});
