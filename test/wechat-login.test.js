import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startWechatLogin, getWechatLoginState, stopWechatLogin } from "../src/lib/wechat-login.js";

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("timed out waiting for condition");
}

test("wechat login returns real connected account id and does not restart connected state", async (t) => {
  const oldStateDir = process.env.OPENCLAW_STATE_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-wechat-login-"));
  t.after(() => {
    stopWechatLogin();
    if (oldStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = oldStateDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  process.env.OPENCLAW_STATE_DIR = tmp;
  let spawnCount = 0;
  const script = `
    const fs = require("node:fs");
    const path = require("node:path");
    const dir = path.join(process.env.OPENCLAW_STATE_DIR, "openclaw-weixin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify(["wx-real-id"]));
    console.log("✅ 已连接");
  `;

  startWechatLogin({
    OPENCLAW_NODE: process.execPath,
    clawArgs: () => {
      spawnCount += 1;
      return ["-e", script];
    },
    accountId: "employee-id",
  });

  await waitFor(() => getWechatLoginState().status === "connected");
  await new Promise((resolve) => setTimeout(resolve, 30));

  const connected = getWechatLoginState();
  assert.equal(connected.connectedAccountId, "wx-real-id");

  const second = startWechatLogin({
    OPENCLAW_NODE: process.execPath,
    clawArgs: () => {
      spawnCount += 1;
      return ["-e", "throw new Error('should not respawn')"];
    },
    accountId: "employee-id",
  });

  assert.equal(spawnCount, 1);
  assert.equal(second.status, "connected");
  assert.equal(second.connectedAccountId, "wx-real-id");
});
