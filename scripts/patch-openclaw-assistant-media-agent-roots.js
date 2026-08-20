import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootsBefore =
  "const localRoots = opts?.config ? getAgentScopedMediaLocalRoots(opts.config, opts.agentId) : getDefaultLocalRoots();";
const rootsAfter = [
  "const requestedAgentId = url.searchParams.get(\"agentId\")?.trim() || opts?.agentId;",
  "\tconst localRoots = opts?.config ? getAgentScopedMediaLocalRoots(opts.config, requestedAgentId) : getDefaultLocalRoots();",
].join("\n");

export function patchOpenClawAssistantMediaAgentRootsSource(source) {
  if (source.includes(rootsAfter)) return source;
  if (!source.includes(rootsBefore)) {
    throw new Error("OpenClaw assistant-media agent-root patch target not found");
  }
  return source.replace(rootsBefore, rootsAfter);
}

export function patchOpenClawAssistantMediaAgentRootsBundle(openclawRoot) {
  if (!openclawRoot) throw new Error("OpenClaw package root directory required");
  const distDir = path.join(openclawRoot, "dist");
  const candidates = fs.readdirSync(distDir)
    .filter((name) => /^control-ui-.*\.js$/.test(name))
    .map((name) => path.join(distDir, name))
    .filter((filePath) => {
      const source = fs.readFileSync(filePath, "utf8");
      return source.includes(rootsBefore) || source.includes(rootsAfter);
    });
  if (candidates.length !== 1) {
    throw new Error(`expected one OpenClaw control-ui bundle, found ${candidates.length}`);
  }
  const filePath = candidates[0];
  const source = fs.readFileSync(filePath, "utf8");
  fs.writeFileSync(filePath, patchOpenClawAssistantMediaAgentRootsSource(source));
  console.log(`[patch] OpenClaw assistant-media agent roots patched: ${path.basename(filePath)}`);
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) patchOpenClawAssistantMediaAgentRootsBundle(process.argv[2]);
