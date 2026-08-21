#!/usr/bin/env bash
set -euo pipefail

# Login shells may replace the image ENV PATH. Keep the immutable Python
# runtime discoverable when this verifier is invoked manually over SSH/CI.
export PATH="/opt/oneclaw-python/bin:${PATH}"

required_bins=(
  ffmpeg gh jq rg tmux unzip summarize
)

documents_enabled=1
required_bins+=(pdftotext qpdf)

if [[ "${ONECLAW_RUNTIME_PROFILE:-standard}" == "full" ]]; then
  required_bins+=(gog blogwatcher blu eightctl gifgrep ordercli sonos wacli codex gemini oracle xurl himalaya nano-pdf op uv)
fi

for binary in "${required_bins[@]}"; do
  command -v "$binary" >/dev/null || {
    echo "missing required template skill binary: $binary" >&2
    exit 1
  }
done

if [[ "$documents_enabled" == "1" ]]; then
python - <<'PY'
import openpyxl
import pdfplumber
import pptx
import pypdf
import reportlab
PY

node -e "require('docx'); require('pptxgenjs')"
fi

status_json="$(mktemp)"
trap 'rm -f "$status_json"' EXIT
openclaw skills list --agent main --json >"$status_json"

node - "$status_json" <<'NODE'
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const skills = Array.isArray(data) ? data : (data.skills || data.result?.skills || []);
const supported = new Set([
  "github", "summarize", "weather",
  "notion", "slack", "discord", "feishu",
  "find-skills", "self-improving-agent", "manage-message-channels",
]);
for (const slug of ["pdf", "xlsx", "docx", "pptx"]) supported.add(slug);
if (process.env.ONECLAW_RUNTIME_PROFILE === "full") {
  for (const slug of ["1password", "himalaya", "nano-pdf", "coding-agent", "gog", "blogwatcher", "blucli", "eightctl", "gifgrep", "ordercli", "sonoscli", "wacli", "gemini", "oracle", "xurl"]) {
    supported.add(slug);
  }
}
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
