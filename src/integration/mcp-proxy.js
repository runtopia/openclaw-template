import crypto from "node:crypto";
import { Readable } from "node:stream";

const MAX_MCP_REQUEST_BYTES = 2 << 20;
const MCP_PROXY_PATH = "/runtime/integrations/mcp";
const REQUEST_HEADERS = ["accept", "content-type", "last-event-id", "mcp-protocol-version", "mcp-session-id"];
const RESPONSE_HEADERS = ["cache-control", "content-type", "mcp-protocol-version", "mcp-session-id", "retry-after"];

export function isLoopbackAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function runtimeMcpApiURL(apiUrl) {
  const base = String(apiUrl || "").trim().replace(/\/+$/u, "");
  if (!base) throw new Error("OneClaw API URL is required for MCP proxy");
  return `${base}${MCP_PROXY_PATH}`;
}

function selectedHeaders(source, names) {
  const headers = {};
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) headers[name] = value.trim();
    else if (Array.isArray(value) && value.length) headers[name] = value.join(", ");
  }
  return headers;
}

async function readBody(req) {
  if (req.method === "GET" || req.method === "DELETE") return undefined;
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_MCP_REQUEST_BYTES) throw new Error("MCP request body exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function tokenMatches(expected, provided) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(provided || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function createRuntimeMcpSidecarProxy({ apiUrl, instanceId, instanceSecret, sidecarToken, fetchImpl = fetch }) {
  const target = runtimeMcpApiURL(apiUrl);
  return async function runtimeMcpSidecarProxy(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      res.status(403).json({ error: "loopback access required" });
      return;
    }
    if (!tokenMatches(sidecarToken, req.headers["x-oneclaw-sidecar-mcp-token"])) {
      res.status(401).json({ error: "invalid Sidecar MCP token" });
      return;
    }
    if (!instanceId || !instanceSecret) {
      res.status(503).json({ error: "runtime authentication unavailable" });
      return;
    }
    if (!new Set(["GET", "POST", "DELETE"]).has(req.method)) {
      res.setHeader("Allow", "GET, POST, DELETE");
      res.status(405).end();
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.status(413).json({ error: "MCP request body is too large" });
      return;
    }
    let upstream;
    const abortController = new AbortController();
    req.once("aborted", () => abortController.abort());
    res.once("close", () => abortController.abort());
    try {
      upstream = await fetchImpl(target, {
        method: req.method,
        headers: {
          ...selectedHeaders(req.headers, REQUEST_HEADERS),
          Authorization: `Bearer ${instanceSecret}`,
          "X-OneClaw-Instance-ID": instanceId,
        },
        ...(body === undefined ? {} : { body }),
        signal: abortController.signal,
      });
    } catch {
      res.status(502).json({ error: "OneClaw MCP proxy unavailable" });
      return;
    }
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.status(upstream.status);
    if (!upstream.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
  };
}
