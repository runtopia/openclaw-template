import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Dockerfile installs unzip for custom skill archives", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^\s*unzip\s*\\$/m);
});

test("Dockerfile preinstalls portable builtin skill dependencies", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  for (const aptPackage of ["ffmpeg", "gh", "jq", "ripgrep", "tmux"]) {
    assert.match(dockerfile, new RegExp(`^\\s*${aptPackage}\\s*\\\\$`, "m"));
  }
  for (const npmPackage of [
    "clawhub@${CLAWHUB_VERSION}",
    "@openai/codex@${CODEX_VERSION}",
    "@google/gemini-cli@${GEMINI_CLI_VERSION}",
    "mcporter@${MCPORTER_VERSION}",
    "@steipete/oracle@${ORACLE_VERSION}",
    "@xdevplatform/xurl@${XURL_VERSION}",
  ]) {
    assert.ok(dockerfile.includes(npmPackage), `${npmPackage} should be installed`);
  }
  for (const module of ["blogwatcher", "blucli", "eightctl", "gifgrep", "ordercli", "sonoscli", "wacli"]) {
    assert.ok(dockerfile.includes(`/${module}/`), `${module} should be built`);
  }
  assert.ok(
    dockerfile.includes("github.com/openclaw/wacli/cmd/wacli@v0.12.0"),
    "wacli must use the module path declared by v0.12.0",
  );
  assert.ok(!dockerfile.includes("github.com/steipete/wacli/"));
});
