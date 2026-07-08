import fs from "node:fs";
import path from "node:path";

const PATCH_MARKER = "中文说明：dashboard 会话已由 sessions.create 创建";

export function patchDashboardSessionSendSource(source) {
  if (source.includes(PATCH_MARKER)) {
    return source;
  }

  const targetPattern =
    /(\s+sessionKey: canonicalKey,\n\s+\.\.\.canonicalKey === "global" && requestedAgentId \? \{ agentId: requestedAgentId \} : \{\},\n)(\s+)message: p\.message,/;
  const match = source.match(targetPattern);
  if (!match) {
    throw new Error("dashboard session patch target not found: sessions.send chat.send params");
  }
  const indent = match[2];

  return source.replace(
    targetPattern,
    [
      "$1",
      `${indent}// 中文说明：dashboard 会话已由 sessions.create 创建，这里必须把既有 sessionId 透传给 chat.send。`,
      `${indent}// 否则 reply 初始化会在后续轮次把同一 dashboard key 当成新会话，触发 session 初始化冲突。`,
      `${indent}sessionId: entry.sessionId,`,
      `${indent}message: p.message,`,
    ].join("\n"),
  );
}

function listSessionBundleFiles(openclawRoot) {
  const distDir = path.join(openclawRoot, "dist");
  if (!fs.existsSync(distDir)) {
    throw new Error(`openclaw dist directory not found: ${distDir}`);
  }
  return fs
    .readdirSync(distDir)
    .filter((name) => /^sessions-[\w-]+\.js$/.test(name))
    .map((name) => path.join(distDir, name));
}

export function patchOpenClawDashboardSessionSend(openclawRoot) {
  const files = listSessionBundleFiles(openclawRoot);
  let changed = 0;
  let alreadyPatched = 0;

  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf-8");
    if (!source.includes('chatHandlers["chat.send"]')) {
      continue;
    }
    let patched;
    try {
      patched = patchDashboardSessionSendSource(source);
    } catch (err) {
      if (String(err?.message || err).includes("dashboard session patch target not found")) {
        continue;
      }
      throw err;
    }
    if (patched === source) {
      alreadyPatched += 1;
      continue;
    }
    fs.writeFileSync(filePath, patched);
    changed += 1;
    console.log(`[patch] dashboard session send patched: ${filePath}`);
  }

  if (changed === 0 && alreadyPatched === 0) {
    throw new Error(`dashboard session patch did not find a sessions.send bundle under ${openclawRoot}`);
  }
  if (changed === 0) {
    console.log("[patch] dashboard session send already patched");
  }
  return { changed, alreadyPatched };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  patchOpenClawDashboardSessionSend(process.argv[2] || "/usr/local/lib/node_modules/openclaw");
}
