import { Readable } from "node:stream";

import { isLoopbackAddress } from "./mcp-proxy.js";

const MAX_GMAIL_REQUEST_BYTES = 64 << 10;
const GMAIL_INVOKE_PATH = "/runtime/integrations/gmail/invoke";
const RESPONSE_HEADERS = ["content-type", "retry-after"];

function runtimeGmailApiURL(apiUrl) {
  const base = String(apiUrl || "").trim().replace(/\/+$/u, "");
  if (!base) throw new Error("OneClaw API URL is required for Gmail proxy");
  return `${base}${GMAIL_INVOKE_PATH}`;
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > MAX_GMAIL_REQUEST_BYTES) throw new Error("Gmail request body exceeds limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createRuntimeGmailProxy({ apiUrl, instanceId, instanceSecret, fetchImpl = fetch }) {
  const target = runtimeGmailApiURL(apiUrl);
  return async function runtimeGmailProxy(req, res) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      res.status(403).json({ error: "loopback access required" });
      return;
    }
    if (!instanceId || !instanceSecret) {
      res.status(503).json({ error: "runtime authentication unavailable" });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.status(405).end();
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      res.status(413).json({ error: "Gmail request body is too large" });
      return;
    }
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 65_000);
    req.once("aborted", () => abortController.abort());
    res.once("close", () => abortController.abort());
    let upstream;
    try {
      upstream = await fetchImpl(target, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${instanceSecret}`,
          "X-OneClaw-Instance-ID": instanceId,
        },
        body,
        signal: abortController.signal,
      });
    } catch {
      clearTimeout(timeout);
      if (!res.headersSent) res.status(502).json({ error: "OneClaw Gmail proxy unavailable" });
      return;
    }
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.status(upstream.status);
    if (!upstream.body) {
      clearTimeout(timeout);
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body);
    stream.once("end", () => clearTimeout(timeout));
    stream.once("error", () => {
      clearTimeout(timeout);
      res.destroy();
    });
    stream.pipe(res);
  };
}
