// Gateway RPC client — a single persistent WS connection from the wrapper
// to the OpenClaw gateway, used ONLY for the wrapper's own RPCs (e.g. the
// whatsapp-login endpoint forwarding `web.login.start`). Frontend clients no
// longer go through the wrapper; they connect directly to the gateway via the
// WS reverse proxy (sidecar `proxy.ws`), each with its own connect handshake
// and subscriptions — so event routing stays per-client (no multiplexing,
// no broadcast cross-talk). See docs/superpowers/specs/2026-06-24-ws-direct-proxy-design.md.
//
// Protocol (openclaw gateway WS, v4):
//   1. Gateway pushes: { type:"event", event:"connect.challenge", payload:{ nonce } }
//   2. Client sends:   { type:"req", id, method:"connect", params:{ minProtocol:4, maxProtocol:4, client, auth:{token}, role, scopes } }
//   3. Gateway responds: { type:"res", id, ok:true, payload: helloOk }

import { WebSocket } from "ws";

const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 30000;
const BACKOFF_MAX_ATTEMPTS = 20;

export function createGatewayRpc({ gatewayHost, gatewayPort, gatewayToken, basePath }) {
  const GATEWAY_WS_URL = `ws://${gatewayHost}:${gatewayPort}${basePath || "/openclaw"}`;
  const GATEWAY_ORIGIN = `http://${gatewayHost}:${gatewayPort}`;

  let gatewayWs = null;
  let gatewayConnected = false;
  let connectNonce = null;
  let hubHandshakeId = null;
  const selfPending = new Map(); // selfRpc id → { resolve }

  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let intentionalClose = false;

  function connectToGateway() {
    if (gatewayWs) {
      if (gatewayWs.readyState === WebSocket.OPEN || gatewayWs.readyState === WebSocket.CONNECTING) {
        return;
      }
      gatewayWs.removeAllListeners();
      gatewayWs = null;
    }
    connectNonce = null;
    hubHandshakeId = null;
    intentionalClose = false;
    console.log(`[gateway-rpc] connecting to gateway at ${GATEWAY_WS_URL}`);

    gatewayWs = new WebSocket(GATEWAY_WS_URL, {
      headers: { Authorization: `Bearer ${gatewayToken}`, Origin: GATEWAY_ORIGIN },
    });

    gatewayWs.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch (err) {
        console.warn(`[gateway-rpc] malformed frame: ${err.message}`);
        return;
      }

      if (frame.type === "event") {
        if (frame.event === "connect.challenge") {
          const nonce = frame.payload?.nonce;
          if (!nonce || typeof nonce !== "string" || nonce.trim().length === 0) {
            console.error("[gateway-rpc] connect.challenge missing nonce, closing");
            gatewayWs.close(1008, "connect challenge missing nonce");
            return;
          }
          connectNonce = nonce.trim();
          sendConnectReq();
        }
        // Other events are not relevant to the wrapper's own RPC use; ignore.
        return;
      }

      if (frame.type === "res") {
        // Handshake response
        if (hubHandshakeId && frame.id === hubHandshakeId) {
          if (frame.ok) {
            gatewayConnected = true;
            reconnectAttempt = 0;
            console.log("[gateway-rpc] handshake completed");
          } else {
            console.error(`[gateway-rpc] handshake failed: ${JSON.stringify(frame.error)}`);
            gatewayConnected = false;
            gatewayWs.close();
          }
          hubHandshakeId = null;
          return;
        }
        // Self-issued RPC response
        if (selfPending.has(frame.id)) {
          const { resolve } = selfPending.get(frame.id);
          selfPending.delete(frame.id);
          resolve(frame);
          return;
        }
        console.warn(`[gateway-rpc] res for unknown req id: ${frame.id}`);
        return;
      }

      console.warn(`[gateway-rpc] unexpected frame type: ${frame.type}`);
    });

    gatewayWs.on("close", (code, reason) => {
      console.warn(`[gateway-rpc] gateway WS closed: code=${code} reason=${reason.toString() || "no reason"}`);
      gatewayWs = null;
      gatewayConnected = false;
      connectNonce = null;
      hubHandshakeId = null;
      for (const { resolve } of selfPending.values()) {
        resolve({ ok: false, error: { code: "disconnected", message: "gateway WS closed" } });
      }
      selfPending.clear();
      if (intentionalClose) { intentionalClose = false; return; }
      scheduleReconnect();
    });

    gatewayWs.on("error", (err) => {
      console.error(`[gateway-rpc] gateway WS error: ${err.message}`);
    });
  }

  function sendConnectReq() {
    if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN) return;
    if (!connectNonce) return;
    hubHandshakeId = `rpc-connect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    gatewayWs.send(JSON.stringify({
      type: "req", id: hubHandshakeId, method: "connect",
      params: {
        minProtocol: 4, maxProtocol: 4,
        client: { id: "openclaw-control-ui", version: "1.0.0", platform: "node", mode: "ui" },
        auth: { token: gatewayToken },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing", "talk.secrets"],
      },
    }));
  }

  function scheduleReconnect() {
    if (reconnectAttempt >= BACKOFF_MAX_ATTEMPTS) {
      console.error(`[gateway-rpc] max reconnect attempts reached, giving up`);
      return;
    }
    reconnectAttempt++;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (reconnectAttempt - 1), BACKOFF_CAP_MS);
    console.log(`[gateway-rpc] reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connectToGateway(); }, delay);
  }

  function rpcGateway(method, params = {}, timeoutMs = 35_000) {
    return new Promise((resolve, reject) => {
      if (!gatewayWs || gatewayWs.readyState !== WebSocket.OPEN || !gatewayConnected) {
        reject(new Error("gateway WS not connected"));
        return;
      }
      const id = `self-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => { selfPending.delete(id); reject(new Error(`rpc timeout: ${method}`)); }, timeoutMs);
      selfPending.set(id, { resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      gatewayWs.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  function start() { connectToGateway(); }

  function restart() {
    intentionalClose = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (gatewayWs) { gatewayWs.removeAllListeners(); gatewayWs.close(); gatewayWs = null; }
    gatewayConnected = false; connectNonce = null; hubHandshakeId = null; reconnectAttempt = 0;
    intentionalClose = false;
    connectToGateway();
  }

  function close() {
    intentionalClose = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (gatewayWs) { gatewayWs.removeAllListeners(); gatewayWs.close(); gatewayWs = null; }
    gatewayConnected = false; connectNonce = null; hubHandshakeId = null;
    for (const { resolve } of selfPending.values()) {
      resolve({ ok: false, error: { code: "disconnected", message: "closing" } });
    }
    selfPending.clear();
  }

  return {
    start,
    restart,
    close,
    isGatewayConnected: () => gatewayConnected,
    rpcGateway,
  };
}
