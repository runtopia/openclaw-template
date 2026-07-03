// auth.js — cookie session + Bearer auth factory
//
// 为什么不用 Basic Auth：浏览器对 401+WWW-Authenticate 会弹原生登录框，而
// Control UI 是 SPA，它的 fetch/XHR/WebSocket 子请求不带 Basic 凭据 → 反复弹窗。
// 改用签名 cookie：登录一次种 cookie，之后所有同源请求（含 WebSocket）自动携带，
// 未登录则 302 跳 /login 页面（不弹窗）。
// 自动化/修复助手可用 Authorization: Bearer <ONECLAW_INSTANCE_SECRET> 访问。

import crypto from "node:crypto";

export function createAuth({ SETUP_PASSWORD, ONECLAW_INSTANCE_SECRET, GATEWAY_TOKEN, PORT }) {
  const AUTH_COOKIE = "ocsess";
  const COOKIE_SECRET = crypto.createHash("sha256")
    .update(`${SETUP_PASSWORD || ""}:${GATEWAY_TOKEN}`).digest("hex");

  function signSession() {
    const payload = String(Date.now());
    const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("hex");
    return `${payload}.${sig}`;
  }
  function verifySession(value) {
    if (!value || !value.includes(".")) return false;
    const idx = value.lastIndexOf(".");
    const payload = value.slice(0, idx);
    const sig = value.slice(idx + 1);
    const expected = crypto.createHmac("sha256", COOKIE_SECRET).update(payload).digest("hex");
    try {
      return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    } catch { return false; }
  }
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || "").split(";")) {
      const i = part.indexOf("=");
      if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return out;
  }
  function bearerMatchesSecret(req) {
    if (!ONECLAW_INSTANCE_SECRET) return false;
    const auth = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) return false;
    const tok = auth.slice(7).trim();
    try {
      return tok.length > 0 && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ONECLAW_INSTANCE_SECRET));
    } catch { return false; }
  }
  // URL query 里的 ?token=<GATEWAY_TOKEN> 也是有效凭据。
  // 浏览器 WebSocket 握手无法自定义 Authorization 头，且跨站/自写客户端不带 cookie，
  // 此时 URL query token 是唯一可行的鉴权通道（Control UI 前端本就把 token 放进 WS URL）。
  // token 即 gateway 的有效凭据，强度等价于 Bearer secret。
  function queryTokenMatchesGateway(req) {
    let tok = "";
    try {
      tok = new URL(req.url, "http://internal").searchParams.get("token") || "";
    } catch { return false; }
    if (!tok || !GATEWAY_TOKEN) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(GATEWAY_TOKEN));
    } catch { return false; }
  }
  function isAuthed(req) {
    // 本地开发：未设密码也未设 secret → 放行
    if (!SETUP_PASSWORD && !ONECLAW_INSTANCE_SECRET) return true;
    if (bearerMatchesSecret(req)) return true;
    if (queryTokenMatchesGateway(req)) return true;
    return verifySession(parseCookies(req)[AUTH_COOKIE]);
  }
  // 页面请求：未登录 302 跳 /login（不弹窗）
  function requireAuthPage(req, res, next) {
    if (isAuthed(req)) return next();
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  // API 请求：未登录返回 401 JSON（不带 WWW-Authenticate，不弹窗）
  function requireAuthApi(req, res, next) {
    if (isAuthed(req)) return next();
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  return { isAuthed, requireAuthPage, requireAuthApi, signSession, verifySession, AUTH_COOKIE };
}
