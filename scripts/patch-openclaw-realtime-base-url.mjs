#!/usr/bin/env node
/**
 * Route OpenClaw's native OpenAI Realtime bridge through a trusted
 * OpenAI-compatible backend such as ClawRouters.
 *
 * OpenClaw 2026.7.1 pins the GA WebSocket URL to api.openai.com. The Template
 * keeps the native protocol/VAD/tool bridge and adds only the provider-level
 * `baseUrl` override required by the env-managed ClawRouters configuration.
 * Anchor matching is intentionally exact and fail-closed for version drift.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PATCH_MARKER = "oneclaw: configurable OpenAI-compatible realtime base URL";
const CONFIG_ORIGINAL = `\t\tmodel: trimToUndefined(raw?.model),
\t\tvoice: normalizeOpenAIRealtimeVoice(raw?.speakerVoice ?? raw?.voice),`;
const CONFIG_PATCHED = `\t\tmodel: trimToUndefined(raw?.model),
\t\t/* ${PATCH_MARKER} */
\t\tbaseUrl: trimToUndefined(raw?.baseUrl),
\t\tvoice: normalizeOpenAIRealtimeVoice(raw?.speakerVoice ?? raw?.voice),`;
const URL_ORIGINAL = `\t\tconst url = \`wss://api.openai.com/v1/realtime?model=\${encodeURIComponent(model)}\`;`;
const URL_PATCHED = `\t\t/* ${PATCH_MARKER} */
\t\tconst realtimeBaseUrl = cfg.baseUrl
\t\t\t? cfg.baseUrl.replace(/\\/+$/, "").replace(/^http:/, "ws:").replace(/^https:/, "wss:")
\t\t\t: "wss://api.openai.com/v1";
\t\tconst url = \`\${realtimeBaseUrl}/realtime?model=\${encodeURIComponent(model)}\`;`;
const BRIDGE_ORIGINAL = `\t\t\t\tapiKey: config.apiKey,
\t\t\t\tmodel: config.model,`;
const BRIDGE_PATCHED = `\t\t\t\tapiKey: config.apiKey,
\t\t\t\tbaseUrl: config.baseUrl,
\t\t\t\tmodel: config.model,`;

function replaceExactlyOnce(content, original, patched, label, file) {
  if (content.includes(patched)) return { content, changed: false };
  const first = content.indexOf(original);
  if (first < 0 || first !== content.lastIndexOf(original)) {
    throw new Error(
      `[patch-openclaw-realtime-base-url] ${label} anchor was ${first < 0 ? "not found" : "ambiguous"} in ${file}`,
    );
  }
  return { content: content.replace(original, patched), changed: true };
}

export function patchOpenclawRealtimeBaseUrl(distDir) {
  if (!existsSync(distDir)) {
    throw new Error(`[patch-openclaw-realtime-base-url] OpenClaw dist directory not found: ${distDir}`);
  }
  const files = readdirSync(distDir).filter((file) => (
    /^realtime-voice-provider-[^.]+\.js$/u.test(file)
  ));
  if (files.length !== 1) {
    throw new Error(
      `[patch-openclaw-realtime-base-url] expected one OpenAI realtime provider bundle, found ${files.length}`,
    );
  }
  const file = files[0];
  const filePath = join(distDir, file);
  let content = readFileSync(filePath, "utf8");
  let changed = false;
  for (const [label, original, patched] of [
    ["provider config", CONFIG_ORIGINAL, CONFIG_PATCHED],
    ["WebSocket URL", URL_ORIGINAL, URL_PATCHED],
    ["bridge config", BRIDGE_ORIGINAL, BRIDGE_PATCHED],
  ]) {
    const result = replaceExactlyOnce(content, original, patched, label, file);
    content = result.content;
    changed ||= result.changed;
  }
  if (!changed) return 0;
  writeFileSync(filePath, content, "utf8");
  console.log(`[patch-openclaw-realtime-base-url] Patched: ${filePath}`);
  return 1;
}

export const testing = {
  PATCH_MARKER,
  CONFIG_ORIGINAL,
  CONFIG_PATCHED,
  URL_ORIGINAL,
  URL_PATCHED,
  BRIDGE_ORIGINAL,
  BRIDGE_PATCHED,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  patchOpenclawRealtimeBaseUrl(resolve(process.argv[2] || "node_modules/openclaw/dist"));
}
