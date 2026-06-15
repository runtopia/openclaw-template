// WebSocket Hub — multiplexed gateway connection for frontend clients.
//
// Replaces http-proxy's 1:1 WS proxying with a hub that maintains a SINGLE
// persistent WS connection to the OpenClaw gateway. Frontend clients connect
// to a local WebSocketServer. The hub routes frames:
//   req  → forward to gateway (prefix frame.id with client index)
//   res  → route to originating client only (via reqOrigin map)
//   event → broadcast to all connected frontend clients
//   connect → intercept and answer locally (hub is already authenticated)

import { WebSocket, WebSocketServer } from "ws";

const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30000;
const BACKOFF_MAX_ATTEMPTS = 20;

export function createWsHub({ gatewayHost, gatewayPort, gatewayToken, basePath }) {
  const GATEWAY_WS_URL = `ws://${gatewayHost}:${gatewayPort}${basePath || "/openclaw"}`;
  const GATEWAY_ORIGIN = `http://${gatewayHost}:${gatewayPort}`;

  // ── State ──────────────────────────────────────────────────

  let gatewayWs = null;         // single persistent connection to gateway
  let gatewayConnected = false;  // true after connect handshake completes
  let clientIndex = 0;          // monotonically increasing client counter
  let reqIdCounter = 0;         // for generating hub's own req IDs (handshake)

  const connectedClients = new Set();  // frontend client WebSocket instances
  const reqOrigin = new Map();         // prefixedId → clientWs (for routing res)
  const clientIndexMap = new Map();    // clientWs → assigned index (for cleanup)

  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let intentionalClose = false;   // true when we deliberately close gateway WS

  const wss = new WebSocketServer({ noServer: true });

  // ── Gateway connection lifecycle ───────────────────────────

  function connectToGateway() {
    // If an old connection is still closing, detach its close handler first
    // to prevent it from overwriting the new gatewayWs reference.
    if (gatewayWs) {
      if (gatewayWs.readyState === WebSocket.OPEN || gatewayWs.readyState === WebSocket.CONNECTING) {
        return; // already connected or connecting — nothing to do
      }
      // readyState is CLOSING or CLOSED — detach to avoid race
      gatewayWs.removeAllListeners();
      gatewayWs = null;
    }

    intentionalClose = false;
    console.log(`[ws-hub] connecting to gateway at ${GATEWAY_WS_URL}`);

    gatewayWs = new WebSocket(GATEWAY_WS_URL, {
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        Origin: GATEWAY_ORIGIN,
      },
    });

    gatewayWs.on("open", () => {
      console.log("[ws-hub] gateway WS connection opened, sending connect handshake");
      reqIdCounter++;
      const handshakeFrame = {
        type: "req",
        id: `hub-handshake-${reqIdCounter}`,
        method: "connect",
        params: {
          minProtocol: 4,
          maxProtocol: 4,
          client: {
            id: "openclaw-control-ui",   // must match GATEWAY_CLIENT_IDS enum
            version: "1.0.0",
            platform: "node",
            mode: "ui",                   // must match GATEWAY_CLIENT_MODES enum
          },
          auth: { token: gatewayToken },
        },
      };
      gatewayWs.send(JSON.stringify(handshakeFrame));
    });

    gatewayWs.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch (err) {
        console.warn(`[ws-hub] malformed frame from gateway: ${err.message}`);
        return;
      }

      if (frame.type === "event") {
        // hello-ok is the gateway's handshake confirmation — always suppress it.
        // Frontend clients get their own synthetic hello-ok from connect interception;
        // broadcasting the gateway's would confuse them.
        if (frame.event === "hello-ok") {
          if (!gatewayConnected) {
            gatewayConnected = true;
            reconnectAttempt = 0;
            console.log("[ws-hub] gateway handshake completed, hub is operational");
          }
          return; // internal only — never broadcast hello-ok to frontend clients
        }
        // Broadcast all other events to every connected frontend client
        broadcastToClients(raw.toString()); // convert Buffer to string (text frames, not binary)
        return;
      }

      if (frame.type === "res") {
        // Route response to the originating client only
        const prefixedId = frame.id;
        const clientWs = reqOrigin.get(prefixedId);
        if (clientWs) {
          reqOrigin.delete(prefixedId);
          // Strip the client prefix to restore the original frame ID
          const originalId = stripClientPrefix(prefixedId);
          const routedFrame = { ...frame, id: originalId };
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify(routedFrame));
          }
        } else {
          // Response for a req we sent ourselves (e.g., handshake) — ignore
          if (frame.id?.startsWith("hub-handshake-")) {
            if (!frame.ok) {
              console.error(`[ws-hub] gateway handshake failed: ${JSON.stringify(frame.error)}`);
              gatewayConnected = false;
              gatewayWs.close();
            }
            return;
          }
          console.warn(`[ws-hub] received res for unknown req id: ${prefixedId}`);
        }
        return;
      }

      console.warn(`[ws-hub] unexpected frame type from gateway: ${frame.type}`);
    });

    gatewayWs.on("close", (code, reason) => {
      const reasonStr = reason.toString() || "no reason";
      console.warn(`[ws-hub] gateway WS closed: code=${code} reason=${reasonStr}`);
      gatewayWs = null;
      gatewayConnected = false;

      if (intentionalClose) {
        intentionalClose = false;
        return; // don't auto-reconnect on deliberate close
      }

      // Auto-reconnect with exponential backoff
      scheduleReconnect();
    });

    gatewayWs.on("error", (err) => {
      console.error(`[ws-hub] gateway WS error: ${err.message}`);
      // The "close" event will follow and handle reconnect
    });
  }

  function scheduleReconnect() {
    if (reconnectAttempt >= BACKOFF_MAX_ATTEMPTS) {
      console.error(`[ws-hub] max reconnect attempts (${BACKOFF_MAX_ATTEMPTS}) reached, giving up`);
      return;
    }
    reconnectAttempt++;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (reconnectAttempt - 1), BACKOFF_CAP_MS);
    console.log(`[ws-hub] reconnecting to gateway in ${delay}ms (attempt ${reconnectAttempt}/${BACKOFF_MAX_ATTEMPTS})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectToGateway();
    }, delay);
  }

  // ── Client ID prefixing ───────────────────────────────────

  function prefixFrameId(clientIdx, originalId) {
    return `c${clientIdx}-${originalId}`;
  }

  function stripClientPrefix(prefixedId) {
    // prefixedId format: "c<index>-<originalId>"
    const match = prefixedId?.match(/^c\d+-(.+)$/);
    return match ? match[1] : prefixedId;
  }

  // ── Frontend client WebSocketServer ───────────────────────

  wss.on("connection", (ws) => {
    const idx = clientIndex++;
    connectedClients.add(ws);
    clientIndexMap.set(ws, idx);
    console.log(`[ws-hub] frontend client connected: index=${idx}, total=${connectedClients.size}`);

    ws.on("message", (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString());
      } catch (err) {
        console.warn(`[ws-hub] malformed frame from client c${idx}: ${err.message}`);
        return;
      }

      // Intercept connect handshake — answer locally, don't forward
      if (frame.type === "req" && frame.method === "connect") {
        const helloOk = {
          type: "event",
          event: "hello-ok",
          payload: {
            protocol: 4,
            server: {
              id: "openclaw-control-ui",
              version: "1.0.0",
            },
          },
          seq: 0,
        };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(helloOk));
        }
        return;
      }

      // Forward req frames to gateway
      if (frame.type === "req") {
        if (!gatewayConnected || !gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) {
          // Gateway not connected — respond locally with an error
          const errorRes = {
            type: "res",
            id: frame.id,
            ok: false,
            error: { message: "Gateway WebSocket not connected" },
          };
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(errorRes));
          }
          return;
        }

        // Prefix the frame ID to avoid collisions across clients
        const prefixedId = prefixFrameId(idx, frame.id);
        reqOrigin.set(prefixedId, ws);
        const forwardedFrame = { ...frame, id: prefixedId };
        gatewayWs.send(JSON.stringify(forwardedFrame));
        return;
      }

      // Frontend clients should not send res or event frames — ignore
      console.warn(`[ws-hub] unexpected frame type from client c${idx}: ${frame.type}`);
    });

    ws.on("close", () => {
      cleanupClient(ws);
    });

    ws.on("error", (err) => {
      console.error(`[ws-hub] client c${idx} WS error: ${err.message}`);
      cleanupClient(ws);
    });
  });

  function cleanupClient(ws) {
    connectedClients.delete(ws);
    const idx = clientIndexMap.get(ws);
    clientIndexMap.delete(ws);

    if (idx !== undefined) {
      console.log(`[ws-hub] frontend client disconnected: index=${idx}, total=${connectedClients.size}`);
    }

    // Remove any pending reqOrigin entries for this client
    // (collect keys first to avoid mutating Map during iteration)
    const prefix = `c${idx}-`;
    const keysToDelete = [];
    for (const key of reqOrigin.keys()) {
      if (key.startsWith(prefix) && reqOrigin.get(key) === ws) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      reqOrigin.delete(key);
    }
  }

  // ── Broadcast ─────────────────────────────────────────────

  function broadcastToClients(text) {
    for (const client of connectedClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(text); // send as text frame (string), not binary Buffer
      }
    }
  }

  // ── Public API ────────────────────────────────────────────

  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }

  function start() {
    connectToGateway();
  }

  function restart() {
    intentionalClose = true;

    // Clear pending reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Close existing gateway connection — detach listeners first
    // to prevent stale close/error handlers from corrupting the new gatewayWs
    // reference or triggering a redundant reconnect.
    if (gatewayWs) {
      gatewayWs.removeAllListeners();
      gatewayWs.close();
      gatewayWs = null;
    }

    gatewayConnected = false;
    reconnectAttempt = 0;

    // Reconnect fresh
    intentionalClose = false;
    connectToGateway();
  }

  function close() {
    intentionalClose = true;

    // Clear reconnect timer
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Close gateway connection — detach listeners first to prevent stale handlers
    if (gatewayWs) {
      gatewayWs.removeAllListeners();
      gatewayWs.close();
      gatewayWs = null;
    }
    gatewayConnected = false;

    // Close all frontend client connections
    for (const client of connectedClients) {
      try { client.close(1001, "Hub shutting down"); } catch {}
    }
    connectedClients.clear();
    reqOrigin.clear();
    clientIndexMap.clear();
    clientIndex = 0; // reset for next start cycle

    // Close the WebSocketServer
    wss.close();
  }

  function isGatewayConnected() {
    return gatewayConnected;
  }

  function getConnectedClientCount() {
    return connectedClients.size;
  }

  return {
    handleUpgrade,
    start,
    restart,
    close,
    isGatewayConnected,
    getConnectedClientCount,
  };
}
