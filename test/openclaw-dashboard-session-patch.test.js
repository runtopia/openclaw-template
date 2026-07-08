import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  patchDashboardSessionSendSource,
  patchOpenClawDashboardSessionSend,
} from "../scripts/patch-openclaw-dashboard-session-send.js";

const sessionsFixture = `
async function handleSessionSend(params) {
  const messageSeq = await readSessionMessageCountAsync({
    agentId: requestedAgentId,
    sessionEntry: entry,
    sessionId: entry.sessionId,
    sessionKey: canonicalKey,
    storePath
  }) + 1;
  await chatHandlers["chat.send"]({
    req: params.req,
    params: {
      sessionKey: canonicalKey,
      ...canonicalKey === "global" && requestedAgentId ? { agentId: requestedAgentId } : {},
      message: p.message,
      thinking: p.thinking,
      attachments: p.attachments,
      timeoutMs: p.timeoutMs,
      idempotencyKey
    },
    respond: () => {},
    context: params.context,
    client: params.client,
    isWebchatConnect: params.isWebchatConnect
  });
}
`;

test("patch passes the existing dashboard session id into chat.send", () => {
  const patched = patchDashboardSessionSendSource(sessionsFixture);

  assert.match(patched, /sessionId: entry\.sessionId,/);
  assert.match(patched, /中文说明：dashboard 会话已由 sessions\.create 创建/);
  assert.match(patched, /message: p\.message/);
});

test("patch is idempotent", () => {
  const once = patchDashboardSessionSendSource(sessionsFixture);
  const twice = patchDashboardSessionSendSource(once);

  assert.equal(twice, once);
});

test("patch handles tab-indented openclaw bundles", () => {
  const source = sessionsFixture.replaceAll("      ", "\t\t\t");
  const patched = patchDashboardSessionSendSource(source);

  assert.match(patched, /\t\t\tsessionId: entry\.sessionId,/);
  assert.match(patched, /dashboard 会话已由 sessions\.create 创建/);
});

test("patch scans real dist bundles and skips unrelated sessions files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-dashboard-session-patch-"));
  try {
    const dist = path.join(root, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(
      path.join(dist, "sessions-files-test.js"),
      'function unrelated(){ return chatHandlers["chat.send"]; }\n',
    );
    fs.writeFileSync(path.join(dist, "sessions-test.js"), sessionsFixture);

    const result = patchOpenClawDashboardSessionSend(root);
    const patched = fs.readFileSync(path.join(dist, "sessions-test.js"), "utf-8");

    assert.deepEqual(result, { changed: 1, alreadyPatched: 0 });
    assert.match(patched, /sessionId: entry\.sessionId,/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
