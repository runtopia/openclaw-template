import crypto from "node:crypto";

const DEFAULT_TTL_MS = 60_000;

function normalizeNext(raw) {
  const value = typeof raw === "string" && raw.startsWith("/") ? raw : "/openclaw/";
  if (value.startsWith("//")) return "/openclaw/";
  return value;
}

function requestOrigin(req, fallbackPort) {
  const xfProto = req.headers["x-forwarded-proto"];
  const proto = (typeof xfProto === "string" ? xfProto.split(",")[0].trim() : xfProto) || req.protocol || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${fallbackPort}`;
  return `${proto}://${host}`;
}

function isHttpsRequest(req) {
  const xfProto = req.headers["x-forwarded-proto"];
  const proto = (typeof xfProto === "string" ? xfProto.split(",")[0].trim() : xfProto) || req.protocol || "http";
  return proto === "https";
}

function sessionCookieAttributes(req) {
  // 控制台页面和实例域名通常不是同源，内嵌 WebSocket 需要浏览器在跨站请求中携带 cookie。
  // HTTPS 入口使用 SameSite=None; Secure；本地 HTTP 调试无法设置 Secure，只能退回 Lax。
  return isHttpsRequest(req)
    ? "HttpOnly; Path=/; SameSite=None; Secure; Max-Age=604800"
    : "HttpOnly; Path=/; SameSite=Lax; Max-Age=604800";
}

export function createBrowserSessionManager({ signSession, authCookie, port, ttlMs = DEFAULT_TTL_MS }) {
  const tickets = new Map();

  function issueLoginUrl(req, next = "/openclaw/") {
    const ticket = `oclt_${crypto.randomBytes(24).toString("hex")}`;
    const normalizedNext = normalizeNext(next);
    const expiresAt = Date.now() + ttlMs;
    tickets.set(ticket, { expiresAt, next: normalizedNext });
    const url = new URL("/oneclaw-login", requestOrigin(req, port));
    url.searchParams.set("ticket", ticket);
    url.searchParams.set("next", normalizedNext);
    return { url: url.toString(), expiresAt };
  }

  function consumeTicket(ticket) {
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry;
  }

  function handleLogin(req, res) {
    const ticket = String(req.query?.ticket || "");
    const entry = consumeTicket(ticket);
    if (!entry) return res.status(401).send("login ticket expired");
    const requestedNext = normalizeNext(req.query?.next);
    const next = requestedNext === entry.next ? entry.next : "/openclaw/";
    res.setHeader("Set-Cookie", `${authCookie}=${signSession()}; ${sessionCookieAttributes(req)}`);
    return res.redirect(next);
  }

  return { issueLoginUrl, handleLogin };
}
