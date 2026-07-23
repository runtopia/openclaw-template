#!/usr/bin/env bash
set -euo pipefail

required_bins=(
  ffmpeg gh jq rg tmux unzip
  summarize gog himalaya nano-pdf op uv
)

for binary in "${required_bins[@]}"; do
  command -v "$binary" >/dev/null || {
    echo "missing required template skill binary: $binary" >&2
    exit 1
  }
done

status_json="$(mktemp)"
trap 'rm -f "$status_json"' EXIT
openclaw skills list --agent main --json >"$status_json"

node - "$status_json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const skills = Array.isArray(data) ? data : (data.skills || data.result?.skills || []);
const supported = new Set([
  "1password", "coding-agent", "github", "gog", "himalaya", "nano-pdf", "summarize", "weather",
  "notion", "slack", "discord", "feishu", "blogwatcher", "gifgrep", "wacli",
]);
const failures = [];
for (const skill of skills) {
  const slug = skill?.name || skill?.slug || skill?.skillKey;
  if (!supported.has(slug)) continue;
  const bins = skill?.missing?.bins;
  if (Array.isArray(bins) && bins.length > 0) failures.push(`${slug}: ${bins.join(", ")}`);
}
if (failures.length > 0) {
  console.error(`supported Linux template skills have missing binaries:\n${failures.join("\n")}`);
  process.exit(1);
}
NODE

echo "Linux template skill dependencies verified"
