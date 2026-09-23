import express from "express";
import httpProxy from "http-proxy";
import net from "node:net";
import { WebSocketServer } from "ws";
import { fileURLToPath } from "node:url";

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
  frameOrigin, novncDir = "/usr/share/novnc", target = "http://127.0.0.1:6080" }) {
  const router = express.Router();
  const controlWs = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const proxy = httpProxy.createProxyServer({ target, ws: true });
  const sockets = new Set();
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
    try { res.json(await handoff[action](controllerToken(req))); }
    catch (err) { res.status(409).json({ error: err.message }); }
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
  router.get("/viewer.js", (_req, res) => res.sendFile(fileURLToPath(new URL("../public/browser.js", import.meta.url))));
  router.get("/viewer.css", (_req, res) => res.sendFile(fileURLToPath(new URL("../public/browser.css", import.meta.url))));
  router.use("/novnc", express.static(novncDir, { index: false, dotfiles: "deny" }));
  router.use((_req, res) => res.sendStatus(404));

  function handleUpgrade(req, socket, head) {
    let pathname;
    try { pathname = new URL(req.url, "http://internal").pathname; }
    catch { socket.destroy(); return true; }
    if (pathname !== "/browser" && !pathname.startsWith("/browser/")) return false;
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
    handoff?.close();
  } };
}
