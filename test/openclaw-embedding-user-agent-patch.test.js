import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  patchOpenclawEmbeddingUserAgent,
  testing,
} from "../scripts/patch-openclaw-embedding-user-agent.mjs";

function createRuntime(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-embedding-user-agent-"));
  const distDir = path.join(root, "dist");
  const filePath = path.join(distDir, "memory-core-host-engine-embeddings-fixture.js");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  return { root, distDir, filePath };
}

test("embedding patch replaces SDK attribution and preserves explicit headers", (t) => {
  const fixture = createRuntime(testing.CLIENT_HEADERS_ORIGINAL);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const initialUserAgent = process.env.ONECLAW_USER_AGENT;
  t.after(() => {
    if (initialUserAgent === undefined) delete process.env.ONECLAW_USER_AGENT;
    else process.env.ONECLAW_USER_AGENT = initialUserAgent;
  });

  assert.equal(patchOpenclawEmbeddingUserAgent(fixture.distDir), 1);
  const patched = fs.readFileSync(fixture.filePath, "utf8");
  assert.match(patched, /oneclaw: unified embedding user-agent/);
  const readHeaders = new Function(
    "providerConfig",
    "remote",
    "apiKey",
    "params",
    "baseUrl",
    "isNativeOpenAIEmbeddingRoute",
    "resolveOpenClawAttributionHeaders",
    `${patched}\nreturn headers;`,
  );
  process.env.ONECLAW_USER_AGENT = "OneClaw-Cloud/3.0.1";
  assert.deepEqual(
    readHeaders({}, {}, "test-key", { provider: "clawrouters" }, "https://example.test/v1", () => false, () => ({})),
    {
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
      "User-Agent": "OneClaw-Cloud/3.0.1",
    },
  );
  assert.equal(
    readHeaders(
      { headers: { "user-agent": "EmbeddingClient/4" } },
      {},
      "test-key",
      { provider: "openai" },
      "https://api.openai.com/v1",
      () => true,
      () => ({ "User-Agent": "openclaw/2026.7.1" }),
    )["user-agent"],
    "EmbeddingClient/4",
  );
  assert.equal(patchOpenclawEmbeddingUserAgent(fixture.distDir), 0);
});

test("embedding patch fails closed when the pinned transport changes", (t) => {
  const fixture = createRuntime("export const changedUpstream = true;\n");
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  assert.throws(
    () => patchOpenclawEmbeddingUserAgent(fixture.distDir),
    /anchor was not found/,
  );
});
