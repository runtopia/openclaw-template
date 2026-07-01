import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHANNEL_ID = "openclaw-weixin";

function replaceRequired(source, before, after, label) {
  if (!source.includes(before)) {
    if (source.includes(after.trim())) return source;
    throw new Error(`weixin access policy patch target not found: ${label}`);
  }
  return source.replace(before, after);
}

function insertPolicyConfig(source) {
  if (source.includes("const configuredDmPolicy = accessConfig.dmPolicy ?? \"pairing\";")) {
    return source;
  }

  const match = source.match(/^([ \t]*)const senderId = full\.from_user_id \?\? "";\n/m);
  if (!match) throw new Error("weixin access policy patch target not found: senderId");

  const indent = match[1];
  const block = [
    `${indent}const channelConfig = deps.config.channels?.["${CHANNEL_ID}"] ?? {};`,
    `${indent}const accountConfig = channelConfig.accounts?.[deps.accountId] ?? {};`,
    `${indent}const accessConfig = { ...channelConfig, ...accountConfig };`,
    `${indent}const configuredDmPolicy = accessConfig.dmPolicy ?? "pairing";`,
    `${indent}const configuredAllowFrom = Array.isArray(accessConfig.allowFrom) ? accessConfig.allowFrom : [];`,
  ].join("\n");

  return source.replace(match[0], `${match[0]}${block}\n`);
}

export function patchWeixinProcessMessageSource(source) {
  let patched = insertPolicyConfig(source);
  patched = replaceRequired(
    patched,
    "dmPolicy: \"pairing\",",
    "dmPolicy: configuredDmPolicy,",
    "command dmPolicy",
  );
  patched = replaceRequired(
    patched,
    "configuredAllowFrom: [],",
    "configuredAllowFrom,",
    "configured allowFrom",
  );
  patched = replaceRequired(
    patched,
    "list.length === 0 || list.includes(id)",
    "list.includes(\"*\") || list.includes(id)",
    "sender allow predicate",
  );
  patched = replaceRequired(
    patched,
    "dmPolicy: \"pairing\",",
    "dmPolicy: configuredDmPolicy,",
    "direct dmPolicy",
  );
  return patched;
}

export function patchWeixinPlugin(rootDir) {
  if (!rootDir) throw new Error("plugin root directory required");
  const files = [
    "dist/src/messaging/process-message.js",
    "src/messaging/process-message.ts",
  ];

  for (const rel of files) {
    const filePath = path.join(rootDir, rel);
    const source = fs.readFileSync(filePath, "utf8");
    const patched = patchWeixinProcessMessageSource(source);
    fs.writeFileSync(filePath, patched);
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  patchWeixinPlugin(process.argv[2]);
}
