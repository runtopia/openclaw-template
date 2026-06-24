// WeChat (openclaw-weixin) QR login process manager.
//
// WeChat's plugin has no web RPC for QR (unlike WhatsApp). The QR is printed
// to stdout only when running `openclaw channels login --channel openclaw-weixin`
// — specifically a URL line:
//   "若二维码未能显示或无法使用，你可以访问以下链接以继续："
//   "https://liteapp.weixin.qq.com/q/<id>?qrcode=<token>&bot_type=3"
// We spawn that CLI, parse its stdout for the qrUrl + connected state, and
// expose it via /repair/wechat-login. The dashboard renders qrUrl with a QR
// library (crisper than the ASCII block).
//
// Single concurrent process: a second /start while one is running is a no-op
// and returns the current state. The process is long-lived (waits for scan,
// refreshes the QR up to MAX refreshes, then exits). We clean up on exit.

import childProcess from "node:child_process";

// Single source of truth for the active login process + last seen state.
let proc = null;
let currentAccountId = null; // the accountId this proc is logging in for
let state = { status: "idle", qrUrl: null, message: null, updatedAt: 0 };

// qrUrl line, e.g. https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=...&bot_type=3
const QR_URL_RE = /https:\/\/liteapp\.weixin\.qq\.com\/q\/\S+/;
// Scan-completed markers (channel.js prints "✅ 已连接..." on success).
const CONNECTED_RE = /已连接|✅|登录成功|connected/i;
// Pairing-code prompt — channels login reads stdin here. bot_type=3 normally
// doesn't trigger this, but if it does (e.g. risky-login verify), the CLI
// blocks on stdin (which we don't write) → surface it as a status instead of
// hanging silently. The dashboard can then tell the user to use the terminal.
const NEED_VERIFY_RE = /输入手机微信显示的数字|need_verifycode|配对码|verify/i;

function setState(patch) {
  state = { ...state, ...patch, updatedAt: Date.now() };
}

export function startWechatLogin({ OPENCLAW_NODE, clawArgs, accountId }) {
  // Idempotent only for the SAME account; switching employees (different
  // accountId) kills the old login proc and starts a fresh one.
  if (proc && currentAccountId === accountId) return getWechatLoginState();
  if (proc) { try { proc.kill(); } catch { /* already gone */ } proc = null; }
  currentAccountId = accountId ?? null;
  state = { status: "starting", qrUrl: null, message: null, updatedAt: Date.now() };

  const baseArgs = ["channels", "login", "--channel", "openclaw-weixin"];
  if (accountId) baseArgs.push("--account", accountId);
  const args = clawArgs(baseArgs);
  try {
    proc = childProcess.spawn(OPENCLAW_NODE, args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    proc = null;
    setState({ status: "error", message: `spawn failed: ${err.message}` });
    return getWechatLoginState();
  }

  setState({ status: "scan", message: "waiting for QR from channels login" });

  const handleOut = (chunk) => {
    const text = chunk.toString();
    const m = text.match(QR_URL_RE);
    if (m) {
      // \S+ already matches the full URL up to the line's end (no whitespace).
      // Do NOT strip trailing '.' — the URL contains dots (liteapp.weixin.qq.com)
      // and a `[.)\]...]` char-class would truncate it to "https://liteapp".
      const url = m[0].replace(/[)\]]+$/, "");
      setState({ qrUrl: url, status: "scan" });
      return;
    }
    if (CONNECTED_RE.test(text)) {
      setState({ status: "connected", message: text.trim().slice(0, 200) });
      return;
    }
    if (NEED_VERIFY_RE.test(text)) {
      setState({ status: "need_verifycode", message: "需要输入手机微信显示的配对码，请在实例终端完成 channels login" });
      return;
    }
    // Keep the last informative (non-QR-glyph, non-empty) line for debugging.
    const line = text.split("\n").map((s) => s.trim()).filter(Boolean).pop();
    if (line && !/[█▄▀▐▌]/.test(line)) setState({ message: line.slice(0, 200) });
  };
  proc.stdout.on("data", handleOut);
  proc.stderr.on("data", handleOut);

  proc.on("exit", (code) => {
    // Only flip to done/error if not already connected.
    setState({ status: state.status === "connected" ? "connected" : (code === 0 ? "done" : "error") });
    proc = null;
  });
  proc.on("error", (err) => {
    setState({ status: "error", message: String(err) });
    proc = null;
  });

  return getWechatLoginState();
}

export function getWechatLoginState() {
  return { ...state };
}

export function stopWechatLogin() {
  if (proc) {
    try { proc.kill(); } catch { /* already gone */ }
    proc = null;
  }
  currentAccountId = null;
  state = { status: "idle", qrUrl: null, message: null, updatedAt: 0 };
}
