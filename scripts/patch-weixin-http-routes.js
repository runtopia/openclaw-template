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

function purgeExpired() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.startedAt > SESSION_TTL_MS) sessions.delete(key);
  }
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
  if (!session) return;
  try {
    const result = await waitForWeixinLogin({
      sessionKey,
      apiBaseUrl: DEFAULT_BASE_URL,
      botType: DEFAULT_ILINK_BOT_TYPE,
    });
    const current = sessions.get(sessionKey);
    if (!current) return;
    if (!result.connected || !result.accountId) {
      current.status = "failed";
      current.error = result.message;
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
  const result = await startWeixinLoginWithQr({
    accountId,
    force,
    botType: DEFAULT_ILINK_BOT_TYPE,
  });
  if (!result.qrcodeUrl) {
    json(res, 500, { error: result.message || "failed to create QR code" });
    return;
  }
  const sessionKey = result.sessionKey || accountId || "";
  sessions.set(sessionKey, {
    sessionKey,
    status: "pending",
    qrDataUrl: result.qrcodeUrl,
    callbackUrl,
    startedAt: Date.now(),
  });
  void waitInBackground(sessionKey);
  json(res, 200, {
    sessionKey,
    qrDataUrl: result.qrcodeUrl,
    message: result.message,
  });
}

async function handleQrStatus(req, res) {
  if (req.method !== "GET") {
    json(res, 405, { error: "method not allowed" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = url.searchParams.get("sessionKey") ?? "";
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
  json(res, 200, {
    status: session.status,
    accountId: session.accountId,
    error: session.error,
  });
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
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  patchWeixinHttpRoutes(process.argv[2]);
}
