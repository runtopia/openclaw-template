// ClawRouters loopback proxy.

import express from "express";
import httpProxy from "http-proxy";

const CR_UPSTREAM = (process.env.CLAWROUTERS_BASE_URL || "https://www.clawrouters.com").replace(/\/+$/, "");

const CR_INJECT_PATHS = [
  "/api/v1/chat/completions",
  "/api/v1/completions",
  "/api/v1/messages",
];

function shouldInjectUser(req) {
  if (req.method !== "POST") return false;
  const urlPath = req.url.split("?")[0];
  if (!CR_INJECT_PATHS.some((p) => urlPath === p || urlPath.endsWith(p))) return false;
  const ct = (req.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("application/json")) return false;
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return false;
  if (Object.keys(req.body).length === 0) return false;
  return true;
}

export function startClawRoutersProxy({ port, endUser }) {
  if (!endUser) {
    console.log("[cr-proxy] ONECLAW_END_USER not set, skipping proxy");
    return null;
  }

  const proxy = httpProxy.createProxyServer({
    target: CR_UPSTREAM,
    changeOrigin: true,
    secure: true,
    selfHandleResponse: false,
    proxyTimeout: 180_000,
    timeout: 180_000,
  });

  proxy.on("proxyReq", (proxyReq, req) => {
    if (!shouldInjectUser(req)) return;
    if (req.body.user) return;
    const bodyStr = JSON.stringify({ ...req.body, user: endUser });
    proxyReq.setHeader("Content-Type", "application/json");
    proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyStr));
    proxyReq.write(bodyStr);
  });

  proxy.on("error", (err, _req, res) => {
    console.error("[cr-proxy] upstream error:", err.message);
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad gateway", detail: err.message }));
    }
  });

  const proxyApp = express();
  proxyApp.use(express.json({ limit: "20mb" }));
  proxyApp.use((req, res) => proxy.web(req, res));

  const baseUrl = `http://127.0.0.1:${port}/api/v1`;
  proxyApp
    .listen(port, "127.0.0.1", () => {
      console.log(`[cr-proxy] listening on ${baseUrl} → ${CR_UPSTREAM} (inject user=${endUser})`);
    })
    .on("error", (err) => {
      console.error(`[cr-proxy] failed to bind ${port}:`, err.message);
    });

  return { baseUrl };
}