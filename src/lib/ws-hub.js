// WebSocket Hub — multiplexed gateway connection for frontend clients.
//
// Replaces http-proxy's 1:1 WS proxying with a hub that maintains a SINGLE
// persistent WS connection to the OpenClaw gateway. Frontend clients connect
// to a local WebSocketServer. The hub routes frames:
//   req  → forward to gateway (prefix frame.id with client index)
//   res  → route to originating client only (via reqOrigin map)
//   event → broadcast to all connected frontend clients
//          (except tick and connect.challenge which are hub-internal)
//   connect req from frontend → respond locally with res(ok=true, payload=cached helloOk)
//
// Gateway WS connect protocol (verified against openclaw source):
//   Step 1: Gateway sends "connect.challenge" event frame with nonce
//   Step 2: Client sends "connect" req frame with nonce + auth token
//   Step 3: Gateway responds with res(ok=true, payload=helloOk object)
//   No separate "hello-ok" event frame is sent — helloOk data comes as res.payload.

import { WebSocket, WebSocketServer } from "ws";

const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30000;
const BACKOFF_MAX_ATTEMPTS = 20;

// Events that are hub-internal and should NOT be broadcast to frontend clients.
const SUPPRESSED_EVENTS = new Set(["tick", "connect.challenge", "hello-ok"]);

export function createWsHub({ gatewayHost, gatewayPort, gatewayToken, basePath }) {
  const GATEWAY_WS_URL = `ws://${gatewayHost}:${gatewayPort}${basePath || "/openclaw"}`;
  const GATEWAY_ORIGIN = `http://${gatewayHost}:${gatewayPort}`;

  // ── State ──────────────────────────────────────────────────

  let gatewayWs = null;              // single persistent connection to gateway
  let gatewayConnected = false;      // true after connect handshake completes
  let connectNonce = null;           // nonce from connect.challenge event
  let cachedHelloOk = null;          // helloOk payload from gateway's res (used for frontend clients)
  let hubHandshakeId = null;         // the req.id we used for our connect handshake
  let clientIndex = 0;              // monotonically increasing client counter

  const connectedClients = new Set();  // frontend client WebSocket instances
  const reqOrigin = new Map();         // prefixedId → clientWs (for routing res)
  const clientIndexMap = new Map();    // clientWs → assigned index (for cleanup)

  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let intentionalClose = false;   // true when we deliberately close gateway WS

  const wss = new WebSocketServer({ noServer: true });

  // ── Gateway connection lifecycle ───────────────────────────
  //
  // OpenClaw gateway WS connect protocol (3-step):
  //   1. Gateway pushes: { type:"event", event:"connect.challenge", payload:{ nonce, ts } }
  //   2. Client sends:   { type:"req", id:"<uuid>", method:"connect", params:{ minProtocol:4, maxProtocol:4, client:{...}, auth:{token}, ... } }
  //   3. Gateway responds: { type:"res", id:"<uuid>", ok:true, payload:{ type:"hello-ok", protocol:4, server:{}, features:{}, snapshot:{}, auth:{}, policy:{} } }

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

    connectNonce = null;
    hubHandshakeId = null;
    intentionalClose = false;
    console.log(`[ws-hub] connecting to gateway at ${GATEWAY_WS_URL}`);

    gatewayWs = new WebSocket(GATEWAY_WS_URL, {
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        Origin: GATEWAY_ORIGIN,
      },
    });

    gatewayWs.on("open", () => {
      console.log("[ws-hub] gateway WS connection opened, waiting for connect.challenge");
      // Gateway will send connect.challenge event frame next.
      // We do NOT send connect immediately — we must wait for the nonce first.
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
        // Step 1: Handle connect.challenge — gateway pushes nonce, then we send connect
        if (frame.event === "connect.challenge") {
          const nonce = frame.payload?.nonce;
          if (!nonce || typeof nonce !== "string" || nonce.trim().length === 0) {
            console.error("[ws-hub] connect.challenge missing nonce, closing");
            gatewayWs.close(1008, "connect challenge missing nonce");
            return;
          }
          connectNonce = nonce.trim();
          console.log("[ws-hub] received connect.challenge nonce, sending connect req");
          sendHubConnectReq();
          return; // internal — don't broadcast challenge to frontend clients
        }

        // hello-ok event: In the current protocol, gateway does NOT send a separate
        // hello-ok event frame. But if it ever does (e.g., protocol change), suppress it.
        if (frame.event === "hello-ok") {
          if (!gatewayConnected) {
            // This shouldn't happen with current protocol, but handle gracefully
            gatewayConnected = true;
            reconnectAttempt = 0;
            console.log("[ws-hub] received hello-ok event (unexpected in protocol v4)");
          }
          return; // suppress — frontend clients get helloOk via res.payload
        }

        // tick events are heartbeat — broadcast to frontend clients so they can
        // reset their tick watchdog timer and avoid "tick timeout" disconnects.
        // (The gateway client uses tick events to detect silent stalls and will
        // close the connection if no tick received for tickIntervalMs * 2.)
        if (frame.event === "tick") {
          broadcastToClients(raw.toString());
          return;
        }

        // All other events → broadcast to frontend clients
        broadcastToClients(raw.toString());
        return;
      }

      if (frame.type === "res") {
        const prefixedId = frame.id;

        // Step 3: Handle our own handshake response
        if (hubHandshakeId && prefixedId === hubHandshakeId) {
          if (frame.ok) {
            // Cache the helloOk payload for use with frontend clients
            cachedHelloOk = frame.payload;
            gatewayConnected = true;
            reconnectAttempt = 0;
            console.log("[ws-hub] gateway handshake completed, hub is operational");
          } else {
            console.error(`[ws-hub] gateway handshake failed: ${JSON.stringify(frame.error)}`);
            gatewayConnected = false;
            cachedHelloOk = null;
            gatewayWs.close();
          }
          hubHandshakeId = null;
          return; // internal — don't route to frontend clients
        }

        // Route other res frames to the originating client only
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
      cachedHelloOk = null;
      connectNonce = null;
      hubHandshakeId = null;

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

  // Step 2: Send connect req to gateway using nonce from connect.challenge
  function sendHubConnectReq() {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) return;
    if (!connectNonce) return;

    hubHandshakeId = `hub-connect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const connectFrame = {
      type: "req",
      id: hubHandshakeId,
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
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing", "talk.secrets"],
        // device field omitted: for token auth + allowInsecureAuth, device pairing
        // is not required. The nonce from connect.challenge is only needed inside
        // the device object for device-pairing auth, which we don't use.
      },
    };
    gatewayWs.send(JSON.stringify(connectFrame));
    console.log(`[ws-hub] sent connect req (id=${hubHandshakeId})`);
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

      // Intercept connect handshake — respond locally with cached helloOk
      // Gateway protocol: connect is a req/res call. The client's request<HelloOk>("connect")
      // Promise resolves via res.payload. We must send a res frame (not an event frame).
      if (frame.type === "req" && frame.method === "connect") {
        if (!cachedHelloOk) {
          // Hub not connected to gateway yet — can't serve helloOk
          const errorRes = {
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Gateway WebSocket not connected",
              retryable: true,
              retryAfterMs: 2000,
            },
          };
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(errorRes));
          }
          return;
        }

        // Respond with res(ok=true) + cached helloOk as payload
        // This resolves the client's request<HelloOk>("connect") Promise,
        // giving them the real helloOk data (features, snapshot, auth, policy).
        const resFrame = {
          type: "res",
          id: frame.id,
          ok: true,
          payload: cachedHelloOk,
        };
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(resFrame));
        }
        console.log(`[ws-hub] client c${idx} connect handshake answered locally with cached helloOk`);
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
    cachedHelloOk = null;
    connectNonce = null;
    hubHandshakeId = null;
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
    cachedHelloOk = null;
    connectNonce = null;
    hubHandshakeId = null;

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
