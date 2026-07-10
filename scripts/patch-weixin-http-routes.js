import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTE_SOURCE = `import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { startWeixinLoginWithQr, waitForWeixinLogin, DEFAULT_ILINK_BOT_TYPE } from "./auth/login-qr.js";
import {
  saveWeixinAccount,
  registerWeixinAccountId,
  unregisterWeixinAccountId,
  listIndexedWeixinAccountIds,
  clearWeixinAccount,
  clearStaleAccountsForUserId,
  DEFAULT_BASE_URL,
  triggerWeixinChannelReload,
} from "./auth/accounts.js";
import { logger } from "./util/logger.js";

const sessions = new Map();
const SESSION_TTL_MS = 6 * 60_000;
const DEFAULT_BINDING_TTL_MS = 5 * 60_000;
const TERMINAL_STATUSES = new Set(["connected", "failed", "expired", "cancelled"]);

function purgeExpired() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (session.status === "pending" && now >= session.expiresAt) {
      session.cancelled = true;
      session.status = "expired";
      session.qrDataUrl = null;
      session.updatedAt = now;
    }
    if (TERMINAL_STATUSES.has(session.status) && now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
}

function sessionResponse(session) {
  return {
    sessionKey: session.sessionKey,
    status: session.status,
    accountId: session.accountId,
    qrDataUrl: session.qrDataUrl,
    qrUpdatedAt: session.qrUpdatedAt,
    expiresAt: new Date(session.expiresAt).toISOString(),
    message: session.message,
    error: session.error,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function waitInBackground(sessionKey) {
  const session = sessions.get(sessionKey);
  if (!session || session.waiterStarted) return;
  session.waiterStarted = true;
  try {
    const result = await waitForWeixinLogin({
      sessionKey,
      apiBaseUrl: DEFAULT_BASE_URL,
      botType: DEFAULT_ILINK_BOT_TYPE,
      timeoutMs: Math.max(1_000, session.expiresAt - Date.now()),
      deadlineAt: session.expiresAt,
      isCancelled: () => session.cancelled || sessions.get(sessionKey) !== session || Date.now() >= session.expiresAt,
      onQrRefreshed: (qrDataUrl, updatedAt) => {
        if (session.cancelled || sessions.get(sessionKey) !== session || Date.now() >= session.expiresAt) return;
        session.qrDataUrl = qrDataUrl;
        session.qrUpdatedAt = new Date(updatedAt || Date.now()).toISOString();
        session.updatedAt = Date.now();
      },
    });
    const current = sessions.get(sessionKey);
    if (!current || current !== session) return;
    if (current.cancelled || result.cancelled || Date.now() >= current.expiresAt) {
      if (current.status === "pending") current.status = Date.now() >= current.expiresAt ? "expired" : "cancelled";
      current.qrDataUrl = null;
      current.updatedAt = Date.now();
      return;
    }
    if (result.alreadyConnected) {
      const accounts = listIndexedWeixinAccountIds();
      current.status = "connected";
      current.accountId = accounts.at(-1);
      current.message = result.message;
      current.updatedAt = Date.now();
      return;
    }
    if (!result.connected || !result.accountId) {
      current.status = "failed";
      current.error = result.message;
      current.qrDataUrl = null;
      current.updatedAt = Date.now();
      logger.warn("[http-routes] login failed: " + result.message);
      return;
    }
    const accountId = normalizeAccountId(result.accountId);
    saveWeixinAccount(accountId, {
      token: result.botToken,
      baseUrl: result.baseUrl,
      userId: result.userId,
    });
    clearStaleAccountsForUserId(accountId, result.userId, () => {});
    registerWeixinAccountId(accountId);
    void triggerWeixinChannelReload();
    current.status = "connected";
    current.accountId = accountId;
    current.qrDataUrl = null;
    current.message = result.message;
    current.updatedAt = Date.now();
    logger.info("[http-routes] login confirmed: accountId=" + accountId);
    if (current.callbackUrl) {
      fetch(current.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionKey,
          accountId,
          wechatUserId: result.userId,
          token: result.botToken,
        }),
      }).catch((err) => logger.warn("[http-routes] callback failed: " + String(err)));
    }
  } catch (err) {
    const current = sessions.get(sessionKey);
    if (current) {
      current.status = "failed";
      current.error = String(err);
      current.qrDataUrl = null;
      current.updatedAt = Date.now();
    }
    logger.error("[http-routes] waitInBackground error: " + String(err));
  }
}

async function handleQrStart(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return;
  }
  let body = {};
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "invalid json" });
    return;
  }
  const accountId = typeof body.accountId === "string" ? body.accountId : undefined;
  const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl : undefined;
  const force = body.force === true;
  purgeExpired();
  const now = Date.now();
  const expiresAt = body.expiresAt == null ? now + DEFAULT_BINDING_TTL_MS : Date.parse(body.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    json(res, 400, { error: "expiresAt must be a future ISO timestamp" });
    return;
  }
  const existing = accountId ? sessions.get(accountId) : null;
  if (!force && existing?.status === "pending" && !existing.cancelled && now < existing.expiresAt) {
    json(res, 200, sessionResponse(existing));
    return;
  }
  const result = await startWeixinLoginWithQr({
    accountId,
    force: force || !!existing,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });
  if (!result.qrcodeUrl) {
    json(res, 500, { error: result.message || "failed to create QR code" });
    return;
  }
  const sessionKey = result.sessionKey || accountId || "";
  const session = {
    sessionKey,
    status: "pending",
    qrDataUrl: result.qrcodeUrl,
    qrUpdatedAt: new Date(now).toISOString(),
    callbackUrl,
    expiresAt,
    startedAt: now,
    updatedAt: now,
    cancelled: false,
    waiterStarted: false,
    message: result.message,
  };
  sessions.set(sessionKey, session);
  void waitInBackground(sessionKey);
  json(res, 200, sessionResponse(session));
}

async function handleQrStatus(req, res) {
  if (req.method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = url.searchParams.get("sessionKey") ?? "";
  purgeExpired();
  if (!sessionKey) {
    const accounts = listIndexedWeixinAccountIds();
    json(res, 200, { connected: accounts.length > 0, accounts });
    return;
  }
  const session = sessions.get(sessionKey);
  if (!session) {
    json(res, 404, { error: "session not found or expired" });
    return;
  }
  json(res, 200, sessionResponse(session));
}

async function handleQrStop(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return;
  }
  let body = {};
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "invalid json" });
    return;
  }
  purgeExpired();
  const sessionKey = typeof body.sessionKey === "string" ? body.sessionKey : "";
  if (!sessionKey) {
    json(res, 400, { error: "sessionKey is required" });
    return;
  }
  const session = sessions.get(sessionKey);
  if (!session) {
    json(res, 200, { success: true, status: "idle", sessionKey });
    return;
  }
  session.cancelled = true;
  session.status = "cancelled";
  session.qrDataUrl = null;
  session.updatedAt = Date.now();
  json(res, 200, { success: true, ...sessionResponse(session) });
}

async function handleLogout(req, res) {
  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" });
    return;
  }
  let body = {};
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "invalid json" });
    return;
  }
  const accountId = typeof body.accountId === "string" ? body.accountId : undefined;
  if (accountId) {
    clearWeixinAccount(accountId);
    unregisterWeixinAccountId(accountId);
  } else {
    for (const id of listIndexedWeixinAccountIds()) {
      clearWeixinAccount(id);
      unregisterWeixinAccountId(id);
    }
  }
  void triggerWeixinChannelReload();
  json(res, 200, { success: true });
}

async function handler(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (p.endsWith("/qr-start")) {
    await handleQrStart(req, res);
    return true;
  }
  if (p.endsWith("/qr-status")) {
    await handleQrStatus(req, res);
    return true;
  }
  if (p.endsWith("/qr-stop")) {
    await handleQrStop(req, res);
    return true;
  }
  if (p.endsWith("/logout")) {
    await handleLogout(req, res);
    return true;
  }
  return false;
}

export function registerWeixinHttpRoutes(api) {
  api.registerHttpRoute({
    path: "/plugins/openclaw-weixin",
    auth: "gateway",
    match: "prefix",
    handler,
  });
  api.logger.info?.("[weixin] registered HTTP routes at /plugins/openclaw-weixin/*");
}
`;

function ensureRouteFile(rootDir) {
  const routePath = path.join(rootDir, "dist", "src", "http-routes.js");
  fs.mkdirSync(path.dirname(routePath), { recursive: true });
  fs.writeFileSync(routePath, ROUTE_SOURCE);
}

function patchIndexSource(source) {
  if (source.includes("registerWeixinHttpRoutes(api);")) return source;
  const importLine = 'import { registerWeixinHttpRoutes } from "./src/http-routes.js";\n';
  const withImport = source.includes(importLine)
    ? source
    : source.replace(/(import .*WeixinConfigSchema.*;\n)/, `$1${importLine}`);
  if (!withImport.includes(importLine)) {
    throw new Error("weixin HTTP route patch target not found: import insertion point");
  }
  const patched = withImport.replace(
    "api.registerChannel({ plugin: weixinPlugin });",
    "api.registerChannel({ plugin: weixinPlugin });\n        registerWeixinHttpRoutes(api);",
  );
  if (patched === withImport) {
    throw new Error("weixin HTTP route patch target not found: registerChannel");
  }
  return patched;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) {
    throw new Error("weixin login QR patch target not found: " + label);
  }
  return source.replace(search, replacement);
}

export function patchLoginQrSource(source) {
  if (source.includes("ONECLAW_QR_LIFECYCLE_PATCH")) return source;
  let patched = source;
  patched = replaceRequired(
    patched,
    "async function refreshQRCode(activeLogin, botType, qrRefreshCount, onScannedReset) {",
    "async function refreshQRCode(activeLogin, botType, qrRefreshCount, onScannedReset, onQrRefreshed) {",
    "refreshQRCode signature",
  );
  const refreshCallbackPattern = /(activeLogin\.startedAt = Date\.now\(\);\n)(\s*)onScannedReset\(\);/;
  if (!refreshCallbackPattern.test(patched)) {
    throw new Error("weixin login QR patch target not found: refresh callback");
  }
  patched = patched.replace(
    refreshCallbackPattern,
    "$1$2onQrRefreshed?.(activeLogin.qrcodeUrl, activeLogin.startedAt);\n$2onScannedReset();",
  );
  patched = replaceRequired(
    patched,
    "const deadline = Date.now() + timeoutMs;",
    `const deadline = Math.min(
        Date.now() + timeoutMs,
        Number.isFinite(opts.deadlineAt) ? opts.deadlineAt : Number.POSITIVE_INFINITY,
    );
    const isCancelled = () => opts.isCancelled?.() === true;
    const cancelLogin = () => {
        activeLogins.delete(opts.sessionKey);
        return { connected: false, cancelled: true, message: "登录已取消。" };
    };`,
    "deadline",
  );
  patched = replaceRequired(
    patched,
    "while (Date.now() < deadline) {",
    "while (Date.now() < deadline) {\n        if (isCancelled()) return cancelLogin();",
    "poll loop cancellation",
  );
  const pollLine = "const statusResponse = await pollQRStatus(currentBaseUrl, activeLogin.qrcode, activeLogin.pendingVerifyCode);";
  patched = replaceRequired(
    patched,
    pollLine,
    pollLine + "\n            if (isCancelled()) return cancelLogin();\n            if (Date.now() >= deadline) break;",
    "post-poll cancellation",
  );
  const refreshTail = "qrRefreshCount, () => { scannedPrinted = false; });";
  const refreshMatches = patched.split(refreshTail).length - 1;
  if (refreshMatches !== 2) {
    throw new Error("weixin login QR patch target not found: refresh hook calls");
  }
  patched = patched.replaceAll(
    refreshTail,
    "qrRefreshCount, () => { scannedPrinted = false; }, opts.onQrRefreshed);",
  );
  return "const ONECLAW_QR_LIFECYCLE_PATCH = true;\n" + patched;
}

export function patchWeixinHttpRoutes(rootDir) {
  if (!rootDir) throw new Error("plugin root directory required");
  ensureRouteFile(rootDir);
  const indexes = [
    path.join(rootDir, "dist", "index.js"),
    path.join(rootDir, "index.ts"),
  ];
  for (const filePath of indexes) {
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, patchIndexSource(source));
  }
  const loginQrPath = path.join(rootDir, "dist", "src", "auth", "login-qr.js");
  if (!fs.existsSync(loginQrPath)) {
    throw new Error("weixin login QR patch target not found: dist/src/auth/login-qr.js");
  }
  const loginQrSource = fs.readFileSync(loginQrPath, "utf8");
  fs.writeFileSync(loginQrPath, patchLoginQrSource(loginQrSource));
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  patchWeixinHttpRoutes(process.argv[2]);
}
