import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const before = `const TELEGRAM_BOT_TOKEN_PATH_RE = /\\/bot\\d{6,}(?::|%3[aA])[A-Za-z0-9_-]{20,}(?=\\/|$)/giu;
function redactSensitiveUrlPath(value) {
\treturn value.replace(TELEGRAM_BOT_TOKEN_PATH_RE, "/bot***");
}`;

const after = `const TELEGRAM_BOT_TOKEN_PATH_RE = /\\/bot\\d{6,}(?::|%3[aA])[A-Za-z0-9_-]{20,}(?=\\/|$)/giu;
const COMPOSIO_SESSION_PATH_RE = /\\/(trs_)[A-Za-z0-9_-]+(?=\\/|$)/giu;
function redactSensitiveUrlPath(value) {
\treturn value.replace(TELEGRAM_BOT_TOKEN_PATH_RE, "/bot***").replace(COMPOSIO_SESSION_PATH_RE, "/$1***");
}`;

export function patchComposioUrlRedactionSource(source) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error("OpenClaw sensitive URL redaction patch target not found");
  return source.replace(before, after);
}

export function patchComposioUrlRedactionBundle(openclawRoot) {
  if (!openclawRoot) throw new Error("OpenClaw package root directory required");
  const distDir = path.join(openclawRoot, "dist");
  const candidates = fs.readdirSync(distDir)
    .filter((name) => /^redact-sensitive-url-.*\.js$/u.test(name))
    .map((name) => path.join(distDir, name))
    .filter((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return source.includes(before) || source.includes(after);
    });
  if (candidates.length !== 1) throw new Error(`expected one OpenClaw sensitive URL bundle, found ${candidates.length}`);
  const filePath = candidates[0];
  fs.writeFileSync(filePath, patchComposioUrlRedactionSource(fs.readFileSync(filePath, "utf8")));
  console.log(`[patch] OpenClaw Composio URL redaction patched: ${path.basename(filePath)}`);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) patchComposioUrlRedactionBundle(process.argv[2]);
