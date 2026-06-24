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
let state = { status: "idle", qrUrl: null, message: null, updatedAt: 0 };

// qrUrl line, e.g. https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=...&bot_type=3
const QR_URL_RE = /https:\/\/liteapp\.weixin\.qq\.com\/q\/\S+/;
// Scan-completed markers (channel.js prints "✅ 已连接..." on success).
const CONNECTED_RE = /已连接|✅|登录成功|connected/i;

function setState(patch) {
  state = { ...state, ...patch, updatedAt: Date.now() };
}

export function startWechatLogin({ OPENCLAW_NODE, clawArgs }) {
  if (proc) return getState(); // already running — idempotent
  state = { status: "starting", qrUrl: null, message: null, updatedAt: Date.now() };

  const args = clawArgs(["channels", "login", "--channel", "openclaw-weixin"]);
  try {
    proc = childProcess.spawn(OPENCLAW_NODE, args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    proc = null;
    setState({ status: "error", message: `spawn failed: ${err.message}` });
    return getState();
  }

  setState({ status: "scan", message: "waiting for QR from channels login" });

  const handleOut = (chunk) => {
    const text = chunk.toString();
    const m = text.match(QR_URL_RE);
    if (m) {
      // Strip any trailing punctuation/whitespace that \S+ wouldn't catch (none
      // expected, but be safe).
      const url = m[0].replace(/[)\].,;].*$/, "");
      setState({ qrUrl: url, status: "scan" });
      return;
    }
    if (CONNECTED_RE.test(text)) {
      setState({ status: "connected", message: text.trim().slice(0, 200) });
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

  return getState();
}

export function getState() {
  return { ...state };
}

export function stopWechatLogin() {
  if (proc) {
    try { proc.kill(); } catch { /* already gone */ }
    proc = null;
  }
  state = { status: "idle", qrUrl: null, message: null, updatedAt: 0 };
}
