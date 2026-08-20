import assert from "node:assert/strict";
import test from "node:test";
import { patchComposioUrlRedactionSource } from "../scripts/patch-openclaw-composio-url-redaction.js";

test("OpenClaw patch redacts Composio Tool Router session path values", () => {
  const source = `const TELEGRAM_BOT_TOKEN_PATH_RE = /\\/bot\\d{6,}(?::|%3[aA])[A-Za-z0-9_-]{20,}(?=\\/|$)/giu;
function redactSensitiveUrlPath(value) {
\treturn value.replace(TELEGRAM_BOT_TOKEN_PATH_RE, "/bot***");
}`;
  const patched = patchComposioUrlRedactionSource(source);
  assert.match(patched, /COMPOSIO_SESSION_PATH_RE/u);
  assert.match(patched, /"\/\$1\*\*\*"/u);
  assert.equal(patchComposioUrlRedactionSource(patched), patched);
});
