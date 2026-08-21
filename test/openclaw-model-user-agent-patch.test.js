import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  patchOpenclawModelUserAgent,
  testing,
} from "../scripts/patch-openclaw-model-user-agent.mjs";

function createRuntime(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-model-user-agent-"));
  const distDir = path.join(root, "dist");
  const filePath = path.join(distDir, "openai-transport-stream-fixture.js");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { root, distDir, filePath };
}

test("model patch injects cloud identity and preserves explicit Provider headers", (t) => {
  const fixture = createRuntime(testing.HEADERS_ORIGINAL);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const initialUserAgent = process.env.ONECLAW_USER_AGENT;
  t.after(() => {
    if (initialUserAgent === undefined) delete process.env.ONECLAW_USER_AGENT;
    else process.env.ONECLAW_USER_AGENT = initialUserAgent;
  });

  assert.equal(patchOpenclawModelUserAgent(fixture.distDir), 1);
  const patched = fs.readFileSync(fixture.filePath, "utf8");
  assert.match(patched, /oneclaw: unified outbound user-agent/);
  const readHeaders = new Function(
    "model",
    `${patched}\nreturn providerHeaders;`,
  );
  process.env.ONECLAW_USER_AGENT = "OneClaw-Cloud/3.0.1";
  assert.deepEqual(readHeaders({ headers: {} }), {
    "User-Agent": "OneClaw-Cloud/3.0.1",
  });
  assert.deepEqual(readHeaders({ headers: { "user-agent": "CustomGateway/4" } }), {
    "user-agent": "CustomGateway/4",
  });
  assert.equal(patchOpenclawModelUserAgent(fixture.distDir), 0);
});

test("model patch fails closed when the pinned transport changes", (t) => {
  const fixture = createRuntime("export const changedUpstream = true;\n");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () => patchOpenclawModelUserAgent(fixture.distDir),
    /anchor was not found/,
  );
});
