#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STANDARD_SKILLS = [
  "discord",
  "docx",
  "feishu",
  "find-skills",
  "github",
  "notion",
  "pdf",
  "pptx",
  "self-improving-agent",
  "slack",
  "summarize",
  "weather",
  "xlsx",
];

const FULL_SKILLS = [
  "1password",
  "blogwatcher",
  "blucli",
  "coding-agent",
  "eightctl",
  "gemini",
  "gifgrep",
  "gog",
  "himalaya",
  "nano-pdf",
  "oracle",
  "ordercli",
  "sonoscli",
  "wacli",
  "xurl",
];

const STANDARD_BINS = ["ffmpeg", "gh", "jq", "pdftotext", "qpdf", "rg", "summarize", "tmux", "unzip"];
const FULL_BINS = [
  "blogwatcher",
  "blu",
  "clawhub",
  "codex",
  "eightctl",
  "gemini",
  "gifgrep",
  "gog",
  "himalaya",
  "nano-pdf",
  "op",
  "oracle",
  "ordercli",
  "sonos",
  "uv",
  "wacli",
  "xurl",
];

function stableDigest(value) {
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function requireBinaries(binaries) {
  for (const binary of binaries) {
    execFileSync("sh", ["-c", "command -v \"$1\" >/dev/null", "sh", binary], { stdio: "ignore" });
  }
}

export function buildRuntimeCapabilities(profile, env = process.env) {
  if (!new Set(["standard", "full"]).has(profile)) {
    throw new Error(`unsupported OneClaw runtime profile: ${profile}`);
  }
  const full = profile === "full";
  const capabilities = ["channels", "documents", "employee-agents", "mcp_snapshot_sync_v1", "media", "runtime-commands"];
  if (full) capabilities.push("browser-automation", "external-agent-clis", "specialist-clis");
  const manifest = {
    schema_version: 1,
    profile,
    image_version: String(env.IMAGE_VERSION || "unknown"),
    openclaw_version: String(env.OPENCLAW_VERSION || "unknown"),
    capabilities,
    supported_skills: [...STANDARD_SKILLS, ...(full ? FULL_SKILLS : [])].sort(),
  };
  return { ...manifest, capability_digest: stableDigest(manifest) };
}

export function writeRuntimeCapabilities(profile, outputPath, env = process.env) {
  requireBinaries([...STANDARD_BINS, ...(profile === "full" ? FULL_BINS : [])]);
  const manifest = buildRuntimeCapabilities(profile, env);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const profile = String(process.argv[2] || process.env.ONECLAW_RUNTIME_PROFILE || "standard");
  const outputPath = process.argv[3] || "/opt/oneclaw/runtime-capabilities.json";
  const manifest = writeRuntimeCapabilities(profile, outputPath);
  console.log(`[capabilities] ${manifest.profile} ${manifest.capability_digest}`);
}
