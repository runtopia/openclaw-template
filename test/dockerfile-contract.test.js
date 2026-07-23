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

test("Dockerfile includes complete Linux template skill dependencies", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24-bookworm$/m);
  for (const aptPackage of ["poppler-utils", "tesseract-ocr", "python3-venv"]) {
    assert.match(dockerfile, new RegExp(`^\\s*${aptPackage}\\s*\\\\$`, "m"));
  }
  assert.ok(dockerfile.includes("@steipete/summarize@${SUMMARIZE_VERSION}"));
  assert.ok(dockerfile.includes("ARG SUMMARIZE_VERSION=0.11.1"));
  assert.ok(dockerfile.includes("github.com/steipete/gogcli/cmd/gog@v0.9.0"));
  assert.ok(dockerfile.includes("ARG HIMALAYA_VERSION=1.2.0"));
  assert.ok(dockerfile.includes("himalaya.${archive_arch}-linux.tgz"));
  assert.ok(dockerfile.includes("sha256sum -c -"));
  assert.ok(dockerfile.includes("ARG OP_VERSION=2.35.0"));
  assert.ok(dockerfile.includes("FROM 1password/op:${OP_VERSION} AS builtin-skill-onepassword"));
  assert.ok(dockerfile.includes("COPY --from=builtin-skill-onepassword /usr/local/bin/op /usr/local/bin/op"));
  assert.ok(dockerfile.includes("nano-pdf==0.2.1"));
  assert.ok(dockerfile.includes("ARG UV_VERSION=0.8.14"));
  assert.ok(dockerfile.includes("uv==${UV_VERSION}"));
  assert.ok(dockerfile.includes("/opt/oneclaw-python/bin"));
});

test("image includes a Linux template skill smoke verifier", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts/verify-linux-template-skills.sh"), "utf8");
  assert.match(script, /openclaw skills list --agent main --json/);
  for (const binary of ["summarize", "gog", "himalaya", "nano-pdf", "uv"]) {
    assert.ok(script.includes(binary), `${binary} should be verified`);
  }
  assert.doesNotMatch(script, /apple-notes|apple-reminders|things-mac/);
});
