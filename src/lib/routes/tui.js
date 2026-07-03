// TUI route + WebSocket handler.

import express from "express";
import pty from "node-pty";
import path from "node:path";
import { WebSocketServer } from "ws";

export function createTuiRouter({ ENABLE_WEB_TUI, OPENCLAW_NODE, clawArgs, isConfigured, workspaceDir, stateDir, TUI_IDLE_TIMEOUT_MS, TUI_MAX_SESSION_MS }) {
  const router = express.Router();
  let activeTuiSession = null;

  router.get("/", (req, res) => {
    if (!ENABLE_WEB_TUI) return res.status(403).type("text/plain").send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
    if (!isConfigured()) return res.redirect("/setup");
    res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
  });

  function createWebSocketServer(httpServer, { verifyTuiAuth }) {
    const wss = new WebSocketServer({ noServer: true });

    wss.on("connection", (ws, req) => {
      const clientIp = req.socket?.remoteAddress || "unknown";
      console.log(`[tui] session started from ${clientIp}`);

      let ptyProcess = null;
      let idleTimer = null;
      let maxSessionTimer = null;

      activeTuiSession = { ws, pty: null, startedAt: Date.now(), lastActivity: Date.now() };

      function resetIdleTimer() {
        if (activeTuiSession) activeTuiSession.lastActivity = Date.now();
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => { console.log("[tui] idle timeout"); ws.close(4002, "Idle timeout"); }, TUI_IDLE_TIMEOUT_MS);
      }

      function spawnPty(cols, rows) {
        if (ptyProcess) return;
        ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
          name: "xterm-256color", cols, rows, cwd: workspaceDir,
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WORKSPACE_DIR: workspaceDir, TERM: "xterm-256color" },
        });
        if (activeTuiSession) activeTuiSession.pty = ptyProcess;
        idleTimer = setTimeout(() => { ws.close(4002, "Idle timeout"); }, TUI_IDLE_TIMEOUT_MS);
        maxSessionTimer = setTimeout(() => { ws.close(4002, "Max session duration"); }, TUI_MAX_SESSION_MS);
        ptyProcess.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(data); });
        ptyProcess.onExit(({ exitCode, signal }) => {
          console.log(`[tui] PTY exited code=${exitCode} signal=${signal}`);
          if (ws.readyState === ws.OPEN) ws.close(1000, "Process exited");
        });
      }

      ws.on("message", (message) => {
        resetIdleTimer();
        try {
          const msg = JSON.parse(message.toString());
          if (msg.type === "resize" && msg.cols && msg.rows) {
            const cols = Math.min(Math.max(msg.cols, 10), 500);
            const rows = Math.min(Math.max(msg.rows, 5), 200);
            if (!ptyProcess) spawnPty(cols, rows); else ptyProcess.resize(cols, rows);
          } else if (msg.type === "input" && msg.data && ptyProcess) {
            ptyProcess.write(msg.data);
          }
        } catch (err) {
          console.warn(`[tui] invalid message: ${err.message}`);
        }
      });

      ws.on("close", () => {
        console.log("[tui] session closed");
        clearTimeout(idleTimer);
        clearTimeout(maxSessionTimer);
        if (ptyProcess) { try { ptyProcess.kill(); } catch {} }
        activeTuiSession = null;
      });

      ws.on("error", (err) => { console.error(`[tui] WebSocket error: ${err.message}`); });
    });

    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname !== "/tui/ws") return;
      if (!ENABLE_WEB_TUI) { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return; }
      if (!verifyTuiAuth(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="OpenClaw TUI"\r\n\r\n'); socket.destroy(); return; }
      if (activeTuiSession) { socket.write("HTTP/1.1 409 Conflict\r\n\r\n"); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    });

    return wss;
  }

  router.createWebSocketServer = createWebSocketServer;
  router.getActiveTuiSession = () => activeTuiSession;

  return router;
}