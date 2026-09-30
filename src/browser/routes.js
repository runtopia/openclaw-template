import express from "express";
import { createTaskMedia } from './media.js';
import httpProxy from "http-proxy";
import net from "node:net";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

function validSelector(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value); }

export async function startManagedBrowser(gatewayRpc) {
  await gatewayRpc.waitUntilConnected(5000);
  let frame;
  try {
    frame = await gatewayRpc.rpcGateway("browser.request", {
      method: "POST", path: "/start", query: { profile: "openclaw" }, body: { headless: false }, timeoutMs: 40000,
    }, 45000);
  } catch (error) {
    // A timeout does not prove the server-side operation was canceled.
    error.browserOperationUncertain = /timeout|timed out/i.test(error.message);
    throw error;
  }
  if (!frame.ok) {
    const error = new Error(frame.error?.message || "Browser start failed");
    error.browserOperationUncertain = frame.error?.code === "disconnected" || /timeout|timed out/i.test(error.message);
    throw error;
  }
  return frame.payload;
}

export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const proto = String(req.headers["x-forwarded-proto"] || req.protocol || "http").split(",")[0].trim();
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
    return new URL(origin).origin === new URL(`${proto}://${host}`).origin;
  } catch { return false; }
}

export function browserFrameAncestors(webUrl) {
  try {
    const url = new URL(webUrl);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) return "'self'";
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return "'self'";
    return `'self' ${url.origin}`;
  } catch { return "'self'"; }
}

export function createBrowserRoutes({ desktop, isAuthed, credentialsConfigured, startBrowser, handoff,
  requireInstanceSecretApi, taskBroker, capturePreview, readTaskPreview, readTaskFrame, viewNativeTask, frameOrigin, novncDir = "/usr/share/novnc", target = "http://127.0.0.1:6080" }) {
  const router = express.Router();
  const controlWs = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const proxy = httpProxy.createProxyServer({ target, ws: true });
  const sockets = new Set();
  const media = createTaskMedia({ readFrame: readTaskFrame });
  proxy.on("error", (_err, _req, socket) => socket?.destroy?.());
  proxy.on("proxyReqWs", (proxyReq) => {
    proxyReq.removeHeader("authorization");
    proxyReq.removeHeader("cookie");
  });
  router.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Desktop viewing reveals logged-in sites: never inherit the wrapper's
    // passwordless-development bypass for this surface.
    if (!credentialsConfigured) return res.status(503).json({ error: "Set SETUP_PASSWORD or ONECLAW_INSTANCE_SECRET to enable browser preview" });
    if (!isAuthed(req)) return res.redirect(`/login?next=${encodeURIComponent("/browser/")}`);
    if (!desktop.status().enabled) return res.status(503).json({ error: "Browser desktop disabled" });
    next();
  });
  router.get("/status", (_req, res) => res.json(desktop.status()));
  router.get('/task-preview', async (req, res) => {
    const sessionId = req.query.sessionId, after = Number(req.query.after), toolCallId = req.query.toolCallId, browserTaskId = req.query.browserTaskId;
    if (!readTaskPreview || typeof sessionId !== 'string' || !/^session_[A-Za-z0-9_-]{1,128}$/.test(sessionId) || (!validSelector(toolCallId) && !validSelector(browserTaskId))) return res.sendStatus(400);
    try { res.json(await readTaskPreview(sessionId, after, { toolCallId, browserTaskId, viewer: req.query.viewer === '1' })); }
    catch { res.status(503).json({ errorCode: 'browser_preview_unavailable' }); }
  });
  router.post(['/task-view', '/task-resolve'], express.json({ limit: '1kb' }), async (req, res) => {
    if (!sameOrigin(req)) return res.sendStatus(403);
    if ((req.body?.toolCallId !== undefined && !validSelector(req.body.toolCallId)) || (req.body?.browserTaskId !== undefined && !validSelector(req.body.browserTaskId))) return res.sendStatus(400);
    if (!viewNativeTask || !/^session_[A-Za-z0-9_-]{1,128}$/.test(req.body?.sessionId || '')) return res.sendStatus(400);
    try { res.json(await viewNativeTask(req.body.sessionId, { toolCallId: req.body.toolCallId, browserTaskId: req.body.browserTaskId }, req.path.endsWith('task-resolve') ? 'status' : 'view')); }
    catch { res.status(409).json({ errorCode: 'browser_task_view_unavailable' }); }
  });
  router.post('/task-manage', express.json({ limit: '2kb' }), async (req, res) => {
    if (!sameOrigin(req)) return res.sendStatus(403);
    const { sessionId, browserTaskId, action } = req.body || {};
    if (!viewNativeTask || !/^session_[A-Za-z0-9_-]{1,128}$/.test(sessionId || '') || !validSelector(browserTaskId) || !['retain', 'unretain', 'close-task', 'status'].includes(action)) return res.sendStatus(400);
    try { res.json(await viewNativeTask(sessionId, { browserTaskId }, action)); }
    catch { res.status(409).json({ errorCode: 'browser_task_action_unavailable' }); }
  });
  router.post('/task-control', express.json({ limit: '8kb' }), async (req, res) => {
    if (!sameOrigin(req) || !taskBroker) return res.sendStatus(403);
    if (!/^session_[A-Za-z0-9_-]{1,128}$/.test(req.body?.sessionId || '')) return res.sendStatus(400);
    try { res.json(await taskBroker({ ...req.body, sessionKey: undefined, nativeSessionId: req.body.sessionId })); }
    catch { res.status(409).json({ errorCode:'browser_task_control_unavailable' }); }
  });
  router.post('/internal/task', (req, res, next) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !requireInstanceSecretApi || !taskBroker) return res.sendStatus(403);
    requireInstanceSecretApi(req, res, next);
  }, express.json({ limit: '8kb' }), async (req, res) => {
    try { res.json(await taskBroker(req.body)); }
    catch { res.status(409).json({ errorCode:'browser_task_control_unavailable' }); }
  });
  router.post('/internal/preview', (req, res, next) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !requireInstanceSecretApi || !capturePreview) return res.sendStatus(403);
    requireInstanceSecretApi(req, res, next);
  }, express.json({ limit: '1kb' }), async (req, res) => {
    try { res.json(await capturePreview(req.body?.targetId, { viewer: req.body?.viewer === true })); }
    catch { res.status(503).json({ errorCode: 'browser_preview_unavailable' }); }
  });
  router.post(['/internal/focus', '/internal/close'], (req, res, next) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) || !requireInstanceSecretApi) return res.sendStatus(403);
    requireInstanceSecretApi(req, res, next);
  }, express.json({ limit: '4kb' }), async (req, res) => {
    const fields = req.body || {};
    if (!handoff || typeof fields.targetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(fields.targetId)
        || ['runId', 'toolCallId', 'sessionKey'].some(key => typeof fields[key] !== 'string' || !fields[key] || fields[key].length > 512)) return res.status(409).json({ errorCode: 'browser_control_conflict' });
    try { res.json(await handoff.focusTask(fields, req.path.endsWith('/close') ? 'close' : 'focus')); }
    catch (error) { res.status(409).json({ errorCode: error.browserOperationUncertain ? 'browser_operation_uncertain' : 'browser_focus_failed' }); }
  });
  const controllerToken = (req) => req.headers["x-browser-controller"];
  router.get("/control/status", async (req, res) => {
    if (!handoff) return res.json({ available: false });
    try { res.json({ available: true, ...await handoff.status(controllerToken(req)) }); }
    catch (err) { res.status(503).json({ available: false, error: err.message }); }
  });
  router.post("/control/:action", async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: "Same-origin request required" });
    if (!handoff) return res.status(503).json({ error: "Browser Use plugin is not enabled" });
    const action = req.params.action;
    if (!["request", "release", "resume", "recover"].includes(action)) return res.sendStatus(404);
    try { res.json(await handoff[action](controllerToken(req), { browserTaskId: req.query.browserTaskId })); }
    catch (err) { res.status(409).json({ error: err.message, errorCode: 'browser_control_conflict' }); }
  });
  let starting;
  router.post("/start", async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).json({ error: "Same-origin request required" });
    if (!desktop.status().ready) return res.status(503).json({ error: "Desktop is not ready" });
    try {
      starting ??= Promise.resolve().then(() => handoff ? handoff.runNative(startBrowser) : startBrowser()).finally(() => { starting = null; });
      await starting;
      res.json({ ok: true });
    } catch (err) { res.status(503).json({ error: err.message }); }
  });
  router.get("/", (req, res) => {
    if (!req.originalUrl.split("?")[0].endsWith("/")) return res.redirect("/browser/");
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors ${browserFrameAncestors(frameOrigin)}`);
    res.sendFile(fileURLToPath(new URL("../public/browser.html", import.meta.url)));
  });
  router.get("/task-viewer.js", (_req, res) => res.sendFile(fileURLToPath(new URL("../public/browser-task.js", import.meta.url))));
  router.get("/viewer.js", (_req, res) => res.sendFile(fileURLToPath(new URL("../public/browser.js", import.meta.url))));
  router.get("/viewer.css", (_req, res) => res.sendFile(fileURLToPath(new URL("../public/browser.css", import.meta.url))));
  router.use("/novnc", express.static(novncDir, { index: false, dotfiles: "deny" }));
  router.use((_req, res) => res.sendStatus(404));

  function handleUpgrade(req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url, "http://internal").pathname; }
    catch { socket.destroy(); return true; }
    if (pathname !== "/browser" && !pathname.startsWith("/browser/")) return false;
    if (pathname === '/browser/task-stream') {
      if (!credentialsConfigured || !isAuthed(req) || !sameOrigin(req)) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      else media.accept(req, socket, head);
      return true;
    }
    if (pathname === "/browser/control/ws") {
      if (!handoff || !credentialsConfigured || !isAuthed(req) || !sameOrigin(req)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return true;
      }
      const token = new URL(req.url, "http://internal").searchParams.get("controller");
      handoff.connect(token, () => {
        let ws;
        controlWs.handleUpgrade(req, socket, head, (connection) => { ws = connection; });
        if (!ws) throw new Error("VNC upgrade failed");
        const upstream = net.connect({ host: "127.0.0.1", port: 5901 });
        ws.on("message", (data, binary) => {
          if (!binary || upstream.writableLength > 1024 * 1024) return ws.terminate();
          upstream.write(data);
        });
        upstream.on("data", (data) => {
          if (ws.readyState !== 1 || ws.bufferedAmount > 8 * 1024 * 1024) return ws.terminate();
          ws.send(data);
        });
        upstream.on("error", () => ws.terminate());
        upstream.on("close", () => ws.terminate());
        ws.on("close", () => upstream.destroy());
        ws.on("error", () => upstream.destroy());
        return ws;
      }).catch(() => { if (!socket.destroyed) socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n"); });
      return true;
    }
    const status = !credentialsConfigured || !desktop.status().ready ? 503
      : !isAuthed(req) ? 401 : !sameOrigin(req) ? 403 : pathname !== "/browser/ws" ? 404 : 0;
    if (status) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return true;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    req.url = "/";
    proxy.ws(req, socket, head);
    return true;
  }
  return { router, handleUpgrade, close() {
    for (const socket of sockets) socket.destroy();
    proxy.close();
    for (const ws of controlWs.clients) ws.terminate();
    controlWs.close();
    media.close();
    handoff?.close();
  } };
}
