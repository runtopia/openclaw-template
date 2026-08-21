#!/usr/bin/env node
/**
 * Gives remote Memory Core embedding traffic OneClaw's unified identity while
 * preserving an explicit case-insensitive embedding User-Agent override.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PATCH_MARKER = "oneclaw: unified embedding user-agent";
const CLIENT_HEADERS_ORIGINAL = `\tconst headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
\tconst headers = {
\t\t"Content-Type": "application/json",
\t\tAuthorization: \`Bearer \${apiKey}\`,
\t\t...headerOverrides
\t};
\tif (isNativeOpenAIEmbeddingRoute(params.provider, baseUrl)) Object.assign(headers, resolveOpenClawAttributionHeaders());`;
const CLIENT_HEADERS_PATCHED = `${CLIENT_HEADERS_ORIGINAL}
\t/* ${PATCH_MARKER} */
\tconst explicitUserAgent = Object.entries(headerOverrides).find(([key, value]) => key.toLowerCase() === "user-agent" && typeof value === "string" && value.trim());
\tconst configuredOneClawUserAgent = process.env.ONECLAW_USER_AGENT?.trim();
\tconst oneClawUserAgent = configuredOneClawUserAgent && configuredOneClawUserAgent.length <= 256 && !/[\\u0000-\\u001f\\u007f-\\u009f]/u.test(configuredOneClawUserAgent) ? configuredOneClawUserAgent : "OneClaw-Cloud/1.0";
\tfor (const key of Object.keys(headers)) if (key.toLowerCase() === "user-agent") delete headers[key];
\theaders[explicitUserAgent?.[0] ?? "User-Agent"] = explicitUserAgent?.[1].trim() ?? oneClawUserAgent;`;

export function patchOpenclawEmbeddingUserAgent(distDir) {
  if (!existsSync(distDir)) {
    throw new Error(`[patch-openclaw-embedding-user-agent] OpenClaw dist directory not found: ${distDir}`);
  }
  const files = readdirSync(distDir).filter((file) => (
    /^memory-core-host-engine-embeddings-[^.]+\.js$/u.test(file)
  ));
  if (files.length !== 1) {
    throw new Error(
      `[patch-openclaw-embedding-user-agent] expected one embedding host bundle, found ${files.length}`,
    );
  }
  const filePath = join(distDir, files[0]);
  let content = readFileSync(filePath, "utf8");
  if (content.includes(CLIENT_HEADERS_PATCHED)) return 0;
  const first = content.indexOf(CLIENT_HEADERS_ORIGINAL);
  if (first < 0 || first !== content.lastIndexOf(CLIENT_HEADERS_ORIGINAL)) {
    throw new Error(
      `[patch-openclaw-embedding-user-agent] Client headers anchor was ${first < 0 ? "not found" : "ambiguous"} in ${files[0]}`,
    );
  }
  content = content.replace(CLIENT_HEADERS_ORIGINAL, CLIENT_HEADERS_PATCHED);
  writeFileSync(filePath, content, "utf8");
  console.log(`[patch-openclaw-embedding-user-agent] Patched: ${filePath}`);
  return 1;
}

export const testing = {
  PATCH_MARKER,
  CLIENT_HEADERS_ORIGINAL,
  CLIENT_HEADERS_PATCHED,
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  patchOpenclawEmbeddingUserAgent(resolve(process.argv[2] || "node_modules/openclaw/dist"));
}
