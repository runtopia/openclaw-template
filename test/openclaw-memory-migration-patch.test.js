import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  patchOpenclawMemoryMigration,
  testing,
} from "../scripts/patch-openclaw-memory-migration.mjs";

const relativeDoctorPath = path.join(
  "extensions",
  "memory-core",
  "doctor-contract-api.js",
);

test("Memory Core migration patch converges duplicate legacy state and is idempotent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-memory-patch-"));
  const distDir = path.join(root, "dist");
  const doctorPath = path.join(distDir, relativeDoctorPath);
  fs.mkdirSync(path.dirname(doctorPath), { recursive: true });
  fs.writeFileSync(
    doctorPath,
    [testing.metaAssertOriginal, testing.duplicateDreamingOriginal].join("\n"),
  );

  assert.equal(patchOpenclawMemoryMigration(distDir), 1);
  const patched = fs.readFileSync(doctorPath, "utf8");
  assert.match(patched, /keep populated canonical index metadata/);
  assert.match(patched, /archive duplicate legacy dreaming state/);
  assert.doesNotMatch(patched, /left legacy source in place/);
  assert.equal(patchOpenclawMemoryMigration(distDir), 0);
  assert.equal(fs.readFileSync(doctorPath, "utf8"), patched);
});

test("Memory Core migration patch fails closed when upstream anchors change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-memory-anchor-"));
  const distDir = path.join(root, "dist");
  const doctorPath = path.join(distDir, relativeDoctorPath);
  fs.mkdirSync(path.dirname(doctorPath), { recursive: true });
  fs.writeFileSync(doctorPath, "export const changedUpstream = true;\n");

  assert.throws(
    () => patchOpenclawMemoryMigration(distDir),
    /anchor was not found/,
  );
});

test("Memory Core migration patch CLI honors an explicit dist directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-memory-cli-"));
  const distDir = path.join(root, "custom-dist");
  const doctorPath = path.join(distDir, relativeDoctorPath);
  fs.mkdirSync(path.dirname(doctorPath), { recursive: true });
  fs.writeFileSync(
    doctorPath,
    [testing.metaAssertOriginal, testing.duplicateDreamingOriginal].join("\n"),
  );

  const result = spawnSync(
    process.execPath,
    [path.resolve("scripts/patch-openclaw-memory-migration.mjs"), distDir],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(doctorPath, "utf8"), /archive duplicate legacy dreaming state/);
});
