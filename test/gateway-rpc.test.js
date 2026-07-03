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
