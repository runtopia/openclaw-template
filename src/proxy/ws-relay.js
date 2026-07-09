// ws-relay.js — 每客户端一条的 WebSocket 中继（浏览器 ↔ openclaw 网关）。
//
// 为什么不再用 http-proxy 的 proxy.ws 透明代理：
//   openclaw 网关（当前版本）的共享密钥鉴权只认 connect 握手帧里的
//   `params.auth.token`，完全不读 `Authorization` 头 / URL `?token`
//   （见网关 dist/auth-*.js 的 authorizeTokenAuth：只比对 connectToken vs authToken）。
//   而浏览器 Control UI 自己没有 gateway token（模板刻意不下发给前端），
//   它发的 connect 帧 auth=none → 网关判 token_missing →
//   “unauthorized: gateway token missing (paste the token in Control UI settings)”。
//   透明字节代理无法改写帧，注入 Authorization 头对这个网关无效。
//
// 解决：为每个浏览器连接单开一条到网关的 WS（1:1，非多路复用——不会重蹈被删除的
// ws-hub 把所有客户端合并成一条网关连接、破坏 per-client 订阅路由的覆辙），
// 并在转发 method:"connect" 的 req 帧时注入 params.auth.token。
// token 始终留在服务端，不进前端、不进 URL。

import { WebSocketServer, WebSocket } from "ws";

export function createGatewayWsRelay({ GATEWAY_HOST, GATEWAY_PORT, GATEWAY_TOKEN }) {
  const wss = new WebSocketServer({ noServer: true });
  const GATEWAY_ORIGIN = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;

  // 仅改写 connect 握手帧：注入 params.auth.token。其它帧原样透传。
  function injectConnectToken(data, isBinary) {
    if (isBinary) return data;
    let text;
    try { text = typeof data === "string" ? data : data.toString("utf8"); } catch { return data; }
    let frame;
    try { frame = JSON.parse(text); } catch { return data; }
    if (!frame || frame.type !== "req" || frame.method !== "connect") return data;
    frame.params = frame.params || {};
    frame.params.auth = { ...(frame.params.auth || {}), token: GATEWAY_TOKEN };
    return JSON.stringify(frame);
  }

  // 调用方已完成 cookie/secret 鉴权，这里只负责建立到网关的中继连接。
  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (client) => {
      const target = `ws://${GATEWAY_HOST}:${GATEWAY_PORT}${req.url || "/openclaw"}`;
      // 从 wrapper（loopback）发起全新连接，天然无 X-Forwarded-*，网关视为本地直连。
      const upstream = new WebSocket(target, { headers: { Origin: GATEWAY_ORIGIN } });
      const pending = [];
      let closed = false;
      const closeBoth = () => {
        if (closed) return;
        closed = true;
        try { client.close(); } catch (e) { /* ignore */ }
        try { upstream.close(); } catch (e) { /* ignore */ }
      };

      upstream.on("open", () => {
        for (const { data, isBinary } of pending) upstream.send(data, { binary: isBinary });
        pending.length = 0;
      });
      // 浏览器 → 网关：改写 connect 帧注入 token，其余透传。
      client.on("message", (data, isBinary) => {
        const out = injectConnectToken(data, isBinary);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(out, { binary: isBinary });
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push({ data: out, isBinary });
      });
      // 网关 → 浏览器：原样透传。
      upstream.on("message", (data, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
      });
      client.on("close", closeBoth);
      upstream.on("close", closeBoth);
      client.on("error", closeBoth);
      upstream.on("error", closeBoth);
    });
  }

  return { handleUpgrade };
}
