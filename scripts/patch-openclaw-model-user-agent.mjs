#!/usr/bin/env node
/**
 * Gives OpenAI SDK-backed model traffic OneClaw's unified identity while
 * preserving an explicit case-insensitive Provider User-Agent override.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PATCH_MARKER = "oneclaw: unified outbound user-agent";
const HEADERS_ORIGINAL = `\tconst providerHeaders = { ...model.headers };`;
const HEADERS_PATCHED = `\tconst providerHeaders = { ...model.headers };
\t/* ${PATCH_MARKER} */
\tconst configuredOneClawUserAgent = process.env.ONECLAW_USER_AGENT?.trim();
\tconst oneClawUserAgent = configuredOneClawUserAgent && configuredOneClawUserAgent.length <= 256 && !/[\\u0000-\\u001f\\u007f-\\u009f]/u.test(configuredOneClawUserAgent) ? configuredOneClawUserAgent : "OneClaw-Cloud/1.0";
\tif (!Object.keys(providerHeaders).some((key) => key.toLowerCase() === "user-agent")) providerHeaders["User-Agent"] = oneClawUserAgent;`;

export function patchOpenclawModelUserAgent(distDir) {
  if (!existsSync(distDir)) {
    throw new Error(`[patch-openclaw-model-user-agent] OpenClaw dist directory not found: ${distDir}`);
  }
  const files = readdirSync(distDir).filter((file) => (
    /^openai-transport-stream-[^.]+\.js$/u.test(file)
  ));
  if (files.length !== 1) {
    throw new Error(
      `[patch-openclaw-model-user-agent] expected one OpenAI transport bundle, found ${files.length}`,
    );
  }
  const filePath = join(distDir, files[0]);
  let content = readFileSync(filePath, "utf8");
  if (content.includes(HEADERS_PATCHED)) return 0;
  const first = content.indexOf(HEADERS_ORIGINAL);
  if (first < 0 || first !== content.lastIndexOf(HEADERS_ORIGINAL)) {
    throw new Error(
      `[patch-openclaw-model-user-agent] Provider headers anchor was ${first < 0 ? "not found" : "ambiguous"} in ${files[0]}`,
    );
  }
  content = content.replace(HEADERS_ORIGINAL, HEADERS_PATCHED);
  writeFileSync(filePath, content, "utf8");
  console.log(`[patch-openclaw-model-user-agent] Patched: ${filePath}`);
  return 1;
}

export const testing = {
  PATCH_MARKER,
  HEADERS_ORIGINAL,
  HEADERS_PATCHED,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  patchOpenclawModelUserAgent(resolve(process.argv[2] || "node_modules/openclaw/dist"));
}
