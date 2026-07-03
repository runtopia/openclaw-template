import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";

import { createGatewayRpc } from "../src/lib/gateway-rpc.js";

function listenServer(server) {
  return new Promise((resolve) => {
    server.once("listening", () => resolve(server.address().port));
  });
}

test("gateway rpc can wait for a delayed gateway connection", async (t) => {
  const server = new WebSocketServer({ noServer: false, host: "127.0.0.1", port: 0 });
  const port = await listenServer(server);
  t.after(() => server.close());

  server.on("connection", (socket) => {
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce-for-test" },
    }));

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.method === "connect") {
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { hello: true } }));
        return;
      }
      if (frame.method === "web.login.start") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { qrDataUrl: "data:image/png;base64,abc", connected: false },
        }));
      }
    });
  });

  const rpc = createGatewayRpc({
    gatewayHost: "127.0.0.1",
    gatewayPort: port,
    gatewayToken: "test-token",
    basePath: "/openclaw",
  });
  t.after(() => rpc.close());

  rpc.start();
  await rpc.waitUntilConnected(1_000);

  const frame = await rpc.rpcGateway("web.login.start", { timeoutMs: 1_000 }, 1_000);
  assert.equal(frame.ok, true);
  assert.equal(frame.payload.qrDataUrl, "data:image/png;base64,abc");
});

test("gateway rpc retries startup-sidecars handshake failures without exponential backoff", async (t) => {
  let connectAttempts = 0;
  const server = new WebSocketServer({ noServer: false, host: "127.0.0.1", port: 0 });
  const port = await listenServer(server);
  t.after(() => server.close());

  server.on("connection", (socket) => {
    connectAttempts += 1;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: `nonce-${connectAttempts}` },
    }));

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.method !== "connect") return;
      if (connectAttempts < 4) {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "gateway starting; retry shortly",
            retryable: true,
            retryAfterMs: 20,
            details: { reason: "startup-sidecars" },
          },
        }));
        socket.close(1013, "gateway starting");
        return;
      }
      socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { hello: true } }));
    });
  });

  const rpc = createGatewayRpc({
    gatewayHost: "127.0.0.1",
    gatewayPort: port,
    gatewayToken: "test-token",
    basePath: "/openclaw",
  });
  t.after(() => rpc.close());

  rpc.start();
  await rpc.waitUntilConnected(1_000);

  assert.equal(connectAttempts, 4);
});

test("gateway rpc surfaces prolonged startup-sidecars retries as stuck startup state", async (t) => {
  let connectAttempts = 0;
  const warnings = [];
  const originalError = console.error;
  console.error = (message, ...args) => {
    warnings.push(String(message));
    originalError.call(console, message, ...args);
  };
  t.after(() => {
    console.error = originalError;
  });

  const server = new WebSocketServer({ noServer: false, host: "127.0.0.1", port: 0 });
  const port = await listenServer(server);
  t.after(() => server.close());

  server.on("connection", (socket) => {
    connectAttempts += 1;
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: `nonce-${connectAttempts}` },
    }));

    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.method !== "connect") return;
      socket.send(JSON.stringify({
        type: "res",
        id: frame.id,
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "gateway starting; retry shortly",
          retryable: true,
          retryAfterMs: 10,
          details: { reason: "startup-sidecars" },
        },
      }));
      socket.close(1013, "gateway starting");
    });
  });

  const rpc = createGatewayRpc({
    gatewayHost: "127.0.0.1",
    gatewayPort: port,
    gatewayToken: "test-token",
    basePath: "/openclaw",
    startupRetryWarnAfterMs: 25,
  });
  t.after(() => rpc.close());

  rpc.start();
  await assert.rejects(() => rpc.waitUntilConnected(120), /gateway WS not connected/);

  const state = rpc.getConnectionState();
  assert.equal(state.connected, false);
  assert.equal(state.startupRetrying, true);
  assert.ok(state.startupRetryCount >= 2);
  assert.equal(state.lastHandshakeError.code, "UNAVAILABLE");
  assert.ok(warnings.some((line) => line.includes("startup sidecars still unavailable")));
});
