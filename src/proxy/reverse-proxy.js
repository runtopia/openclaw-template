// reverse-proxy.js — http-proxy factory for openclaw gateway
//
// 反代到 gateway 的 token 注入必须用 proxy.on("proxyReq"/"proxyReqWs") 事件，
// 不能直接改 req.headers（否则 WS 升级 token_missing）。
// 必须剥离入站 X-Forwarded-* / Forwarded / X-Real-IP（否则 gateway 判 isLocalClient=false
// 强制 device pairing）。

import httpProxy from "http-proxy";

export function createReverseProxy({ GATEWAY_HOST, GATEWAY_PORT, GATEWAY_TOKEN, PROXY_TIMEOUT_MS }) {
  // gateway 鉴权通过注入 Authorization: Bearer 头完成（token 永不进 URL）。
  // Origin 改写成 gateway 自身地址，满足 gateway.controlUi.allowedOrigins 校验。
  // 这是经过验证的方式（参考原 server.js + CLAUDE.md quirk #6）。
  const GATEWAY_ORIGIN = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;
  const proxy = httpProxy.createProxyServer({
    target: GATEWAY_ORIGIN,
    ws: true,
    xfwd: false,            // 关键：不要加 X-Forwarded-*（见 stripForwardedHeaders 说明）
    changeOrigin: true,
    // chat completions / responses 会触发完整 agent 推理（数十秒~数分钟），
    // 默认无 proxyTimeout 时上游慢响应会被提前断开 → proxy.on("error") → 502
    // "gateway unavailable"。放宽到 PROXY_TIMEOUT_MS（默认 10 分钟）。
    proxyTimeout: PROXY_TIMEOUT_MS,
    timeout: PROXY_TIMEOUT_MS,
  });

  // gateway 的 isLocalDirectRequest() 只要看到任何 X-Forwarded-* / Forwarded / X-Real-IP
  // 头，就判定 isLocalClient=false，进而拒绝 Control UI 的 allowInsecureAuth +
  // dangerouslyDisableDeviceAuth bypass，强制 device pairing（浏览器报 "pairing required:
  // device is not approved yet"）。自写 WS 客户端只用受限 scope、不申请 operator，所以不受影响。
  // sidecar 是 gateway（bind=loopback）唯一的可信前置代理，且已在本层做 cookie/token 鉴权，
  // 因此剥离这些转发头、让 gateway 把连接视为本地直连，是安全且必要的。
  const FORWARDED_HEADERS = ["forwarded", "x-real-ip", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port"];
  function stripForwardedHeaders(headers) {
    if (!headers) return;
    for (const key of Object.keys(headers)) {
      const k = key.toLowerCase();
      if (k === "forwarded" || k === "x-real-ip" || k.startsWith("x-forwarded-")) delete headers[key];
    }
  }
  function dropForwardedOnProxyReq(proxyReq) {
    for (const h of FORWARDED_HEADERS) proxyReq.removeHeader(h);
  }

  proxy.on("proxyReq", (proxyReq) => {
    dropForwardedOnProxyReq(proxyReq);
    proxyReq.setHeader("Authorization", `Bearer ${GATEWAY_TOKEN}`);
    proxyReq.setHeader("Origin", GATEWAY_ORIGIN);
  });
  // WebSocket upgrade: inject the same Bearer token + strip forwarded headers so
  // the gateway treats the proxied client as a trusted local connection (and each
  // frontend client gets its own gateway connect handshake / subscriptions).
  proxy.on("proxyReqWs", (proxyReq) => {
    dropForwardedOnProxyReq(proxyReq);
    proxyReq.setHeader("Authorization", `Bearer ${GATEWAY_TOKEN}`);
    proxyReq.setHeader("Origin", GATEWAY_ORIGIN);
  });
  proxy.on("error", (err, _req, res) => {
    console.error("[proxy]", err.message);
    if (res && !res.headersSent && typeof res.writeHead === "function") {
      res.writeHead(502).end("gateway unavailable");
    }
  });

  return { proxy, stripForwardedHeaders };
}
