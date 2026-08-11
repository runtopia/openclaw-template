import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  main,
  parseGatewayRunArgs,
  resolveOpenClawLayout,
  SUPPORTED_OPENCLAW_VERSION,
} from "../scripts/openclaw-gateway-fast.mjs";

function makeHost({ version = SUPPORTED_OPENCLAW_VERSION, runModules = 1, runBody = "" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-fast-gateway-"));
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "openclaw", version, type: "module" }));
  fs.writeFileSync(path.join(dist, "entry.js"), "export {};\n");
  for (let index = 0; index < runModules; index += 1) {
    fs.writeFileSync(
      path.join(dist, `run-${index}.js`),
      `async function runGatewayCommand() { ${runBody} }\nexport { runGatewayCommand };\n`,
    );
  }
  return { root, entry: path.join(dist, "entry.js") };
}

test("fast Gateway layout accepts only the validated OpenClaw host contract", (t) => {
  const host = makeHost();
  t.after(() => fs.rmSync(host.root, { recursive: true, force: true }));
  const layout = resolveOpenClawLayout({ entryPath: host.entry });
  assert.equal(layout.version, SUPPORTED_OPENCLAW_VERSION);
  assert.equal(path.basename(layout.runModulePath), "run-0.js");
});

test("fast Gateway layout rejects version drift and ambiguous exports", (t) => {
  const future = makeHost({ version: "2026.7.2" });
  const ambiguous = makeHost({ runModules: 2 });
  t.after(() => {
    fs.rmSync(future.root, { recursive: true, force: true });
    fs.rmSync(ambiguous.root, { recursive: true, force: true });
  });
  assert.throws(() => resolveOpenClawLayout({ entryPath: future.entry }), /not validated/);
  assert.throws(() => resolveOpenClawLayout({ entryPath: ambiguous.entry }), /expected one/);
});

test("fast Gateway parser preserves the wrapper's run options", () => {
  assert.deepEqual(parseGatewayRunArgs([
    "gateway", "run", "--bind", "loopback", "--port", "18789",
    "--auth", "token", "--token", "secret", "--compact",
  ]), {
    bind: "loopback",
    port: "18789",
    auth: "token",
    token: "secret",
    compact: true,
  });
  assert.throws(() => parseGatewayRunArgs(["gateway", "status"]), /only supports/);
  assert.throws(() => parseGatewayRunArgs(["gateway", "run", "--future-option"]), /unsupported/);
});

test("fast Gateway does not start a second CLI after direct startup begins", async (t) => {
  const host = makeHost({ runBody: 'throw new Error("startup failed after lock");' });
  const previousEntry = process.env.OPENCLAW_ENTRY;
  process.env.OPENCLAW_ENTRY = host.entry;
  t.after(() => {
    if (previousEntry === undefined) delete process.env.OPENCLAW_ENTRY;
    else process.env.OPENCLAW_ENTRY = previousEntry;
    fs.rmSync(host.root, { recursive: true, force: true });
  });

  await assert.rejects(
    main(["gateway", "run", "--port", "18789"]),
    /startup failed after lock/,
  );
});
