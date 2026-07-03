# WebSocket Hub — Multi-Client Message Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 1:1 `http-proxy` WS proxy with a WS Hub that broadcasts `event` frames to all connected clients and routes `res` frames only to the requesting client, fixing the multi-client message routing bug.

**Architecture:** The wrapper maintains a single persistent WebSocket connection to the OpenClaw gateway (doing the `connect` handshake itself). Frontend clients connect to a local `WebSocketServer`. The hub routes: `req` frames → forward to gateway (with ID prefixing to avoid collisions), `res` frames → route to the originating client only (via `reqOrigin` map), `event` frames → broadcast to all connected clients. The `connect` handshake from frontend clients is intercepted and answered locally (wrapper already authenticated).

**Tech Stack:** Node.js, `ws` library (already in deps), Express, existing gateway manager

---

## File Structure

| File | Responsibility | Status |
|------|---------------|--------|
| `src/lib/ws-hub.js` | WS Hub: gateway connection, client server, frame routing, req ID prefixing, connect interception | **Create** |
| `src/server.js` | Remove `http-proxy` WS usage, import and wire WS Hub into upgrade handler; keep `http-proxy` for HTTP only | **Modify** |
| `src/sidecar.js` | Same WS Hub integration (sidecar has its own upgrade handler with cookie auth) | **Modify** |

---

### Task 1: Create `src/lib/ws-hub.js` — Core WS Hub Module

**Files:**
- Create: `src/lib/ws-hub.js`
- Reference: `src/lib/routes/tui.js` (pattern for `WebSocketServer({ noServer: true })`)
- Reference: memory `reference-openclaw-ws-protocol.md` (frame format, connect handshake)

- [ ] **Step 1: Create the WS Hub module**

```javascript
// src/lib/ws-hub.js
// WebSocket Hub — replaces http-proxy's 1:1 WS proxying with a multiplexed hub.
//
// Routing rules:
//   req frames  → forward to gateway (prefix frame.id with client index to avoid collisions)
//   res frames  → route to the originating client only (via reqOrigin map)
//   event frames → broadcast to all connected frontend clients
//
// The hub maintains a SINGLE persistent WS connection to the gateway,
// doing the connect handshake itself. Frontend clients that send a
// connect frame get a fake hello-ok response (the hub is already authenticated).

import { WebSocket, WebSocketServer } from "ws";

const CONNECT_PARAMS = {
  minProtocol: 1,
  maxProtocol: 1,
  client: {
    id: "openclaw-wrapper-hub",
    version: "1.0.0",
    platform: "node",
    mode: "operator",
  },
};

const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function createWsHub({ gatewayHost, gatewayPort, gatewayToken, basePath = "/openclaw" }) {
  const GATEWAY_WS_URL = `ws://${gatewayHost}:${gatewayPort}${basePath}`;
  const reqOrigin = new Map();       // prefixedReqId → clientWs
  const connectedClients = new Set(); // Set<WebSocket> — all frontend client connections
  let clientIndex = 0;               // monotonically increasing, used as ID prefix
  let gatewayWs = null;              // WebSocket connection to gateway
  let intentionalClose = false;      // true when hub.close() is called
  let reconnectDelay = RECONNECT_DELAY_MS;
  let reconnectTimer = null;

  // ─── Gateway connection lifecycle ─────────────────────────────

  function connectToGateway() {
    if (gatewayWs) return;
    intentionalClose = false;

    gatewayWs = new WebSocket(GATEWAY_WS_URL, {
      headers: {
        Authorization: `Bearer ${gatewayToken}`,
        Origin: `http://${gatewayHost}:${gatewayPort}`,
      },
    });

    gatewayWs.on("open", () => {
      console.log("[ws-hub] connected to gateway");
      reconnectDelay = RECONNECT_DELAY_MS; // reset on successful connect

      // Send connect handshake
      const connectFrame = {
        type: "req",
        id: "hub-connect",
        method: "connect",
        params: { ...CONNECT_PARAMS, auth: { token: gatewayToken } },
      };
      gatewayWs.send(JSON.stringify(connectFrame));
    });

    gatewayWs.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch {
        console.warn("[ws-hub] non-JSON frame from gateway, ignoring");
        return;
      }

      if (frame.type === "res") {
        // Response frame: strip client prefix from id → route to originating client
        const prefixedId = frame.id;
        const originClient = reqOrigin.get(prefixedId);
        reqOrigin.delete(prefixedId);

        if (originClient && originClient.readyState === WebSocket.OPEN) {
          // Restore original frame.id before sending to client
          const originalId = stripClientPrefix(prefixedId);
          const clientFrame = { ...frame, id: originalId };
          originClient.send(JSON.stringify(clientFrame));
        } else {
          console.warn(`[ws-hub] res for ${prefixedId} — client gone, dropping`);
        }
      } else if (frame.type === "event") {
        // Event frame: broadcast to all connected frontend clients
        for (const client of connectedClients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(raw.toString());
          }
        }
      } else {
        console.warn(`[ws-hub] unknown frame type from gateway: ${frame.type}`);
      }
    });

    gatewayWs.on("close", (code, reason) => {
      gatewayWs = null;
      if (intentionalClose) return; // hub.close() called — don't reconnect
      console.warn(`[ws-hub] gateway WS closed (code=${code}), reconnecting in ${reconnectDelay}ms`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connectToGateway();
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
      }, reconnectDelay);
    });

    gatewayWs.on("error", (err) => {
      console.error(`[ws-hub] gateway WS error: ${err.message}`);
    });
  }

  // ─── Client ID prefixing ────────────────────────────────────

  // Each client gets a unique prefix (cN-) for req frame IDs so that
  // when two clients use the same id (e.g. "1"), the gateway sees
  // different prefixed IDs and responses don't collide.
  function prefixWithClient(clientIdx, originalId) {
    return `c${clientIdx}-${originalId}`;
  }

  function stripClientPrefix(prefixedId) {
    const match = prefixedId.match(/^c\d+-(.+)$/);
    return match ? match[1] : prefixedId;
  }

  // ─── Frontend client server ─────────────────────────────────

  const clientWss = new WebSocketServer({ noServer: true });

  clientWss.on("connection", (clientWs, req) => {
    const idx = clientIndex++;
    const clientIp = req.socket?.remoteAddress || "unknown";
    console.log(`[ws-hub] client #${idx} connected from ${clientIp}`);
    connectedClients.add(clientWs);

    clientWs.on("message", (raw) => {
      let frame;
      try { frame = JSON.parse(raw.toString()); } catch {
        console.warn(`[ws-hub] client #${idx} sent non-JSON, ignoring`);
        return;
      }

      // Intercept connect handshake — wrapper already authenticated with gateway
      if (frame.method === "connect") {
        const helloOk = {
          type: "event",
          event: "hello-ok",
          payload: {
            protocol: 1,
            server: { id: "openclaw-wrapper-hub", version: "1.0.0" },
          },
          seq: 0,
        };
        clientWs.send(JSON.stringify(helloOk));
        console.log(`[ws-hub] client #${idx} connect handshake answered locally`);
        return;
      }

      // Forward req frames to gateway with prefixed ID
      if (frame.type === "req") {
        const prefixedId = prefixWithClient(idx, frame.id);
        reqOrigin.set(prefixedId, clientWs);
        const forwarded = { ...frame, id: prefixedId };
        if (gatewayWs?.readyState === WebSocket.OPEN) {
          gatewayWs.send(JSON.stringify(forwarded));
        } else {
          // Gateway not connected — send error back to client
          clientWs.send(JSON.stringify({
            type: "res",
            id: frame.id,
            ok: false,
            error: { code: "gateway_unavailable", message: "Gateway WebSocket not connected" },
          }));
        }
      } else {
        // Other frame types from client — forward raw (shouldn't normally happen)
        if (gatewayWs?.readyState === WebSocket.OPEN) {
          gatewayWs.send(raw.toString());
        }
      }
    });

    clientWs.on("close", () => {
      console.log(`[ws-hub] client #${idx} disconnected`);
      connectedClients.delete(clientWs);
      // Clean up any pending req origin entries for this client
      for (const [prefixedId, ws] of reqOrigin.entries()) {
        if (ws === clientWs) reqOrigin.delete(prefixedId);
      }
    });

    clientWs.on("error", (err) => {
      console.warn(`[ws-hub] client #${idx} error: ${err.message}`);
    });
  });

  // ─── Public interface ───────────────────────────────────────

  function handleUpgrade(req, socket, head) {
    clientWss.handleUpgrade(req, socket, head, (ws) => {
      clientWss.emit("connection", ws, req);
    });
  }

  function start() {
    connectToGateway();
  }

  function close() {
    intentionalClose = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // Close all frontend clients
    for (const client of connectedClients) {
      try { client.close(1001, "Hub shutting down"); } catch {}
    }
    connectedClients.clear();
    reqOrigin.clear();
    // Close gateway connection
    if (gatewayWs) {
      try { gatewayWs.close(1001, "Hub shutting down"); } catch {}
      gatewayWs = null;
    }
    console.log("[ws-hub] closed");
  }

  function isGatewayConnected() {
    return gatewayWs?.readyState === WebSocket.OPEN;
  }

  function getConnectedClientCount() {
    return connectedClients.size;
  }

  return {
    handleUpgrade,
    start,
    close,
    isGatewayConnected,
    getConnectedClientCount,
  };
}
```

- [ ] **Step 2: Verify the module syntax**

Run: `node --check src/lib/ws-hub.js`
Expected: no output (syntax OK)

- [ ] **Step 3: Commit**

```bash
git add src/lib/ws-hub.js
git commit -m "feat(ws-hub): create WebSocket Hub module for multi-client routing"
```

---

### Task 2: Integrate WS Hub into `src/server.js`

**Files:**
- Modify: `src/server.js:20` (remove `http-proxy` import or keep for HTTP only)
- Modify: `src/server.js:309` (keep `gatewayProxy` for HTTP, remove WS-related config)
- Modify: `src/server.js:321-324` (remove `proxyReqWs` handler — no longer needed)
- Modify: `src/server.js:446-462` (replace upgrade handler with WS Hub)
- Modify: `src/server.js:468-498` (add WS Hub cleanup in graceful shutdown)

- [ ] **Step 1: Add WS Hub import and instantiation**

Add after the existing imports (around line 22):

```javascript
import { createWsHub } from "./lib/ws-hub.js";
```

Add after the gateway manager creation (around line 143), before the OneClaw integration:

```javascript
// WebSocket Hub — multiplexes frontend clients over a single gateway WS connection
const wsHub = createWsHub({
  gatewayHost: INTERNAL_GATEWAY_HOST,
  gatewayPort: INTERNAL_GATEWAY_PORT,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  basePath: "/openclaw",
});
```

- [ ] **Step 2: Remove WS-related http-proxy config**

Keep `http-proxy` for HTTP proxying only. Remove the `ws: true` option and the `proxyReqWs` handler:

Change line 309 from:
```javascript
const gatewayProxy = httpProxy.createProxyServer({ target: gateway.GATEWAY_TARGET, ws: true, xfwd: true, changeOrigin: true });
```
to:
```javascript
const gatewayProxy = httpProxy.createProxyServer({ target: gateway.GATEWAY_TARGET, xfwd: true, changeOrigin: true });
```

Remove lines 321-324 (the `proxyReqWs` handler):
```javascript
// DELETE these lines:
gatewayProxy.on("proxyReqWs", (proxyReq) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
  proxyReq.setHeader("Origin", GATEWAY_ORIGIN);
});
```

- [ ] **Step 3: Replace the upgrade handler**

Replace lines 446-462 with the WS Hub upgrade handler:

```javascript
server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === "/tui/ws") return; // handled by tuiRouter's WebSocket server

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await gateway.ensureGatewayRunning();
  } catch (err) {
    console.warn(`[websocket] gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }

  // Route gateway WS upgrades through the WS Hub
  // Hub broadcasts event frames to all clients and routes res frames to the requester
  wsHub.handleUpgrade(req, socket, head);
});
```

- [ ] **Step 4: Start WS Hub after gateway is ready**

In the startup orchestration section, start the WS Hub when the gateway becomes ready. After each `gateway.ensureGatewayRunning()` call that succeeds, start the hub:

In the boot startup block (around line 399-401), change:
```javascript
gateway.ensureGatewayRunning()
  .then(() => console.log("[wrapper] gateway started successfully at boot"))
```
to:
```javascript
gateway.ensureGatewayRunning()
  .then(() => { wsHub.start(); console.log("[wrapper] gateway started successfully at boot"); })
```

In the auto-config block (around line 428-430), change:
```javascript
gateway.ensureGatewayRunning()
  .then(() => console.log("[wrapper] gateway started successfully after auto-config"))
```
to:
```javascript
gateway.ensureGatewayRunning()
  .then(() => { wsHub.start(); console.log("[wrapper] gateway started successfully after auto-config"); })
```

- [ ] **Step 5: Add WS Hub cleanup to graceful shutdown**

In the `gracefulShutdown` function (after line 471 `oneclaw.stop()`), add:

```javascript
wsHub.close();
```

- [ ] **Step 6: Verify syntax**

Run: `node --check src/server.js`
Expected: no output (syntax OK)

- [ ] **Step 7: Commit**

```bash
git add src/server.js
git commit -m "feat(server): integrate WS Hub — replace http-proxy WS with multiplexed client routing"
```

---

### Task 3: Integrate WS Hub into `src/sidecar.js`

**Files:**
- Modify: `src/sidecar.js` — add WS Hub import, instantiation, upgrade handler replacement, shutdown cleanup

The sidecar has its own upgrade handler (lines 537-547) that uses `http-proxy`'s WS proxying with cookie auth. The WS Hub replaces the proxy WS, but the sidecar's cookie auth (`isAuthed(req)`) must remain as a gate before accepting client upgrades.

- [ ] **Step 1: Add WS Hub import and instantiation in sidecar.js**

Find the existing imports area. Add:

```javascript
import { createWsHub } from "./lib/ws-hub.js";
```

Find where gateway constants are defined (INTERNAL_GATEWAY_PORT, etc.). Add after gateway manager creation:

```javascript
const wsHub = createWsHub({
  gatewayHost: INTERNAL_GATEWAY_HOST,
  gatewayPort: INTERNAL_GATEWAY_PORT,
  gatewayToken: OPENCLAW_GATEWAY_TOKEN,
  basePath: "/openclaw",
});
```

- [ ] **Step 2: Remove `ws: true` from proxy config and `proxyReqWs` handler**

Same pattern as server.js — the sidecar's proxy config is around line 423:
```javascript
ws: true,
```
Remove this line.

Remove the `proxyReqWs` handler if present (check sidecar.js for similar `proxyReqWs` event handler).

- [ ] **Step 3: Replace sidecar's upgrade handler**

Replace lines 537-547:

```javascript
server.on("upgrade", (req, socket, head) => {
  if (!isAuthed(req)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  // Hub handles the WS routing: events broadcast, responses 1:1
  wsHub.handleUpgrade(req, socket, head);
});
```

Note: The `stripForwardedHeaders(req.headers)` call that was in the old handler — this was stripping `X-Forwarded-*` headers from the HTTP upgrade request. Since the WS Hub's gateway connection is made by the wrapper itself (not by proxying the client's upgrade request), those headers don't reach the gateway anyway. The hub creates its own fresh WS connection to the gateway. So `stripForwardedHeaders` is no longer needed in the upgrade handler.

- [ ] **Step 4: Start WS Hub after gateway ready and add shutdown cleanup**

In the sidecar's startup section, after `gateway.ensureGatewayRunning()` succeeds, call `wsHub.start()`.

In the `shutdown()` function, add `wsHub.close()` before `server.close()`.

- [ ] **Step 5: Verify syntax**

Run: `node --check src/sidecar.js`
Expected: no output (syntax OK)

- [ ] **Step 6: Commit**

```bash
git add src/sidecar.js
git commit -m "feat(sidecar): integrate WS Hub for multi-client WS routing"
```

---

### Task 4: Handle Gateway Restart — WS Hub Reconnection

**Files:**
- Modify: `src/lib/ws-hub.js` — add `restart()` method
- Modify: `src/server.js` — call `wsHub.restart()` when gateway restarts

When the gateway process is restarted (by the repair assistant, setup wizard, or crash recovery), the WS Hub's connection to the gateway becomes stale. The hub must reconnect.

- [ ] **Step 1: Add restart method to ws-hub.js**

Add to the return object in `src/lib/ws-hub.js`:

```javascript
function restart() {
  // Close existing gateway connection (will auto-reconnect via close handler)
  intentionalClose = true; // prevent auto-reconnect from the close handler
  if (gatewayWs) {
    try { gatewayWs.close(1001, "Gateway restarting"); } catch {}
    gatewayWs = null;
  }
  // Reconnect with fresh state
  reconnectDelay = RECONNECT_DELAY_MS; // reset backoff
  intentionalClose = false;
  connectToGateway();
  console.log("[ws-hub] reconnecting after gateway restart");
}
```

Add `restart` to the return object:
```javascript
return {
  handleUpgrade,
  start,
  restart,
  close,
  isGatewayConnected,
  getConnectedClientCount,
};
```

- [ ] **Step 2: Wire WS Hub restart into gateway restart flow in server.js**

The gateway manager's `restartGateway()` is called from:
- Repair assistant (`restart_gateway` tool → `POST /repair/restart`)
- Setup wizard (blocking restart after config changes)

After `gateway.restartGateway()` succeeds, the WS Hub needs to reconnect. Find all calls to `gateway.restartGateway()` in server.js and add `wsHub.restart()` after:

In `src/lib/routes/setup.js` (the setup wizard calls restartGateway), the setup router already has `restartGateway` passed as a dependency. The setup wizard's blocking restart waits for readiness, so we should start the hub after it completes. This is handled by the setup router itself — we can pass `wsHub` as a dependency so the setup router can call `wsHub.restart()` after gateway restart.

Add `wsHub` to the setupRouter dependencies:
```javascript
const setupRouter = createSetupRouter({
  ...existing deps...,
  wsHub,
});
```

In the repair router, same pattern:
```javascript
const repairRouter = createRepairRouter({
  ...existing deps...,
  wsHub,
});
```

Both routers will call `wsHub.restart()` after `restartGateway()` completes.

- [ ] **Step 3: Also restart hub on gateway crash auto-recovery**

In `src/lib/gateway.js`, the exit handler auto-restarts the gateway on unexpected crashes. After the gateway restarts and becomes ready, the WS Hub connection is dead. The hub's own `close` handler already auto-reconnects (see Task 1 reconnect logic), so this is handled automatically — no additional wiring needed.

Verify: when the gateway process exits unexpectedly, the hub's WS connection closes → hub's `close` handler fires → `intentionalClose` is false → auto-reconnect kicks in after `reconnectDelay`. ✅

- [ ] **Step 4: Commit**

```bash
git add src/lib/ws-hub.js src/server.js
git commit -m "feat(ws-hub): add restart() method, wire into gateway restart flow"
```

---

### Task 5: Manual Testing — Multi-Client WebSocket Routing

**Files:** No code changes — verification only

- [ ] **Step 1: Build and run locally**

```bash
docker build -t openclaw-railway-template .
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template
```

- [ ] **Step 2: Open Control UI in 3 browser tabs**

Open `http://localhost:8080/setup` → complete onboarding → then open 3 tabs at `http://localhost:8080/openclaw`

- [ ] **Step 3: Test chat broadcast — send from Tab A, verify all tabs see response**

1. In Tab A, send a message to the bot
2. Verify: Tab A shows the bot's reply ✅
3. Verify: Tab B also shows the reply ✅
4. Verify: Tab C also shows the reply ✅
5. Verify: Tab A does NOT stay stuck in "responding" ✅

- [ ] **Step 4: Test RPC isolation — request from Tab A, only Tab A gets response**

1. In Tab A, trigger an RPC action (e.g., open agent settings, list files)
2. Verify: Tab A gets the response ✅
3. Verify: Tab B and Tab C do NOT receive Tab A's RPC response ✅

- [ ] **Step 5: Test gateway restart — hub reconnects**

1. Trigger a gateway restart via the repair assistant
2. Verify: all 3 tabs reconnect (may briefly show disconnected) ✅
3. Verify: chat continues working after reconnect ✅

- [ ] **Step 6: Test client disconnect — hub cleans up**

1. Close Tab B
2. Verify: logs show `[ws-hub] client #N disconnected` ✅
3. Verify: Tab A and Tab C still work ✅

---

## Self-Review

**1. Spec coverage:**
- ✅ Chat events broadcast to all clients → Task 1 (event frame routing) + Task 5 (manual test)
- ✅ RPC responses routed only to requester → Task 1 (res frame routing + reqOrigin map) + Task 5 (manual test)
- ✅ Connect handshake handled locally → Task 1 (connect interception)
- ✅ Request ID collision avoidance → Task 1 (client ID prefixing)
- ✅ Gateway restart reconnection → Task 4
- ✅ Client disconnect cleanup → Task 1 (close handler + reqOrigin cleanup)
- ✅ Both server.js and sidecar.js → Task 2 + Task 3
- ✅ Graceful shutdown → Task 2 + Task 3 (wsHub.close())
- ✅ http-proxy kept for HTTP → Task 2 (remove ws:true only)

**2. Placeholder scan:**
- No TBD/TODO/fill-in-later found
- All code blocks contain complete implementation
- All test steps have specific verification criteria

**3. Type consistency:**
- `createWsHub()` params match between definition (ws-hub.js) and callers (server.js, sidecar.js)
- `wsHub.handleUpgrade/start/restart/close/isGatewayConnected/getConnectedClientCount` — all consistent
- `restartGateway()` call patterns unchanged — `wsHub.restart()` added alongside
