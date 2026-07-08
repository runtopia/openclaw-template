import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { removeChannelRuntimeArtifacts } from "../src/repair/config-ops.js";

function makeStateDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "channel-runtime-artifacts-"));
}

test("removeChannelRuntimeArtifacts clears WeChat plugin account state", () => {
  const stateDir = makeStateDir();
  const weixinDir = path.join(stateDir, "openclaw-weixin");
  const accountsDir = path.join(weixinDir, "accounts");
  const credentialsDir = path.join(stateDir, "credentials");
  const legacySyncDir = path.join(stateDir, "agents", "default", "sessions", ".openclaw-weixin-sync");
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(credentialsDir, { recursive: true });
  fs.mkdirSync(path.join(credentialsDir, "openclaw-weixin"), { recursive: true });
  fs.mkdirSync(legacySyncDir, { recursive: true });

  fs.writeFileSync(path.join(weixinDir, "accounts.json"), JSON.stringify(["77597573942e-im-bot", "other-im-bot"]));
  fs.writeFileSync(path.join(accountsDir, "77597573942e-im-bot.json"), "{}");
  fs.writeFileSync(path.join(accountsDir, "77597573942e-im-bot.sync.json"), "{}");
  fs.writeFileSync(path.join(accountsDir, "77597573942e-im-bot.context-tokens.json"), "{}");
  fs.writeFileSync(path.join(accountsDir, "77597573942e@im.bot.json"), "{}");
  fs.writeFileSync(path.join(credentialsDir, "openclaw-weixin-77597573942e-im-bot-allowFrom.json"), "{}");
  fs.writeFileSync(path.join(credentialsDir, "openclaw-weixin", "credentials.json"), "{}", { flag: "w" });
  fs.writeFileSync(path.join(legacySyncDir, "default.json"), "{}");
  fs.writeFileSync(path.join(accountsDir, "other-im-bot.json"), "{}");

  const removed = removeChannelRuntimeArtifacts({
    stateDir,
    channel: "openclaw-weixin",
    accountId: "77597573942e-im-bot",
  });

  assert.ok(removed.some((item) => item.endsWith("77597573942e-im-bot.json")));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(weixinDir, "accounts.json"), "utf8")), ["other-im-bot"]);
  assert.equal(fs.existsSync(path.join(accountsDir, "77597573942e-im-bot.json")), false);
  assert.equal(fs.existsSync(path.join(accountsDir, "77597573942e-im-bot.sync.json")), false);
  assert.equal(fs.existsSync(path.join(accountsDir, "77597573942e-im-bot.context-tokens.json")), false);
  assert.equal(fs.existsSync(path.join(accountsDir, "77597573942e@im.bot.json")), false);
  assert.equal(fs.existsSync(path.join(credentialsDir, "openclaw-weixin-77597573942e-im-bot-allowFrom.json")), false);
  assert.equal(fs.existsSync(path.join(credentialsDir, "openclaw-weixin", "credentials.json")), false);
  assert.equal(fs.existsSync(path.join(legacySyncDir, "default.json")), false);
  assert.equal(fs.existsSync(path.join(accountsDir, "other-im-bot.json")), true);
});

test("removeChannelRuntimeArtifacts falls back to the only indexed WeChat account", () => {
  const stateDir = makeStateDir();
  const weixinDir = path.join(stateDir, "openclaw-weixin");
  const accountsDir = path.join(weixinDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  fs.writeFileSync(path.join(weixinDir, "accounts.json"), JSON.stringify(["real-im-bot"]));
  fs.writeFileSync(path.join(accountsDir, "real-im-bot.json"), "{}");
  fs.writeFileSync(path.join(accountsDir, "real-im-bot.sync.json"), "{}");

  removeChannelRuntimeArtifacts({
    stateDir,
    channel: "openclaw-weixin",
    accountId: "emp-1",
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(weixinDir, "accounts.json"), "utf8")), []);
  assert.equal(fs.existsSync(path.join(accountsDir, "real-im-bot.json")), false);
  assert.equal(fs.existsSync(path.join(accountsDir, "real-im-bot.sync.json")), false);
});
