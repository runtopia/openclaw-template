import crypto from "node:crypto";
import http from "node:http";

const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024;
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_REGISTRATION_GRACE_MS = 1_000;
const DEFAULT_TERMINAL_TTL_MS = 60 * 60 * 1000;

function sendJson(response, status, body) {
  if (response.destroyed || response.writableEnded) return;
  const data = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  response.end(data);
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

async function readJsonBody(request, maxRequestBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxRequestBytes) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return chunks.length === 0
    ? {}
    : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export class InteractionBrokerService {
  constructor({
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    registrationGraceMs = DEFAULT_REGISTRATION_GRACE_MS,
    terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
  } = {}) {
    this.maxWaitMs = maxWaitMs;
    this.registrationGraceMs = registrationGraceMs;
    this.terminalTtlMs = terminalTtlMs;
    this.pending = new Map();
    this.terminal = new Map();
    this.registrationWaiters = new Map();
  }

  setTerminal(toolCallId, value) {
    const previous = this.terminal.get(toolCallId);
    if (previous) clearTimeout(previous.timeout);
    const timeout = setTimeout(() => {
      if (this.terminal.get(toolCallId)?.timeout === timeout) {
        this.terminal.delete(toolCallId);
      }
    }, this.terminalTtlMs);
    timeout.unref?.();
    this.terminal.set(toolCallId, { ...value, timeout });
  }

  notifyRegistered(toolCallId) {
    const waiters = this.registrationWaiters.get(toolCallId);
    if (!waiters) return;
    this.registrationWaiters.delete(toolCallId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(true);
    }
  }

  waitForRegistration(toolCallId) {
    if (this.pending.has(toolCallId)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const waiters = this.registrationWaiters.get(toolCallId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.registrationWaiters.delete(toolCallId);
        resolve(false);
      }, this.registrationGraceMs);
      const waiter = { resolve, timeout };
      const waiters = this.registrationWaiters.get(toolCallId) ?? new Set();
      waiters.add(waiter);
      this.registrationWaiters.set(toolCallId, waiters);
    });
  }

  waitForInput(toolCallId) {
    const terminal = this.terminal.get(toolCallId);
    if (terminal?.state === "answered") {
      return Promise.reject(new Error("INPUT_REQUEST_ALREADY_ANSWERED"));
    }
    if (terminal?.state === "expired") {
      return Promise.reject(new Error("INPUT_REQUEST_TIMED_OUT"));
    }

    const existing = this.pending.get(toolCallId);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.reject(new Error("INPUT_REQUEST_REPLACED"));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.get(toolCallId)?.timeout !== timeout) return;
        this.pending.delete(toolCallId);
        this.setTerminal(toolCallId, { state: "expired" });
        reject(new Error("INPUT_REQUEST_TIMED_OUT"));
      }, this.maxWaitMs);
      this.pending.set(toolCallId, { resolve, reject, timeout });
      this.notifyRegistered(toolCallId);
    });
  }

  submit({ runId, toolCallId, answers }) {
    const terminal = this.terminal.get(toolCallId);
    if (terminal?.state === "expired") {
      return { success: false, code: "INTERACTION_EXPIRED" };
    }
    if (terminal?.state === "answered") {
      if (terminal.runId === runId && JSON.stringify(terminal.answers) === JSON.stringify(answers)) {
        return { success: true, status: "already_submitted" };
      }
      return { success: false, code: "INTERACTION_ALREADY_ANSWERED" };
    }

    const pending = this.pending.get(toolCallId);
    if (!pending) {
      return { success: false, code: "INTERACTION_NOT_FOUND" };
    }

    clearTimeout(pending.timeout);
    this.pending.delete(toolCallId);
    this.setTerminal(toolCallId, {
      state: "answered",
      runId,
      answers,
    });
    pending.resolve(answers);
    return { success: true, status: "submitted" };
  }

  async submitWhenReady(payload) {
    const immediate = this.submit(payload);
    if (immediate.code !== "INTERACTION_NOT_FOUND") return immediate;
    await this.waitForRegistration(payload.toolCallId);
    return this.submit(payload);
  }

  expire(toolCallId, reason = "INPUT_REQUEST_CANCELLED") {
    const pending = this.pending.get(toolCallId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    this.pending.delete(toolCallId);
    this.setTerminal(toolCallId, { state: "expired" });
    pending.reject(new Error(reason));
    return true;
  }

  close() {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("BROKER_SHUTDOWN"));
    }
    for (const entry of this.terminal.values()) {
      clearTimeout(entry.timeout);
    }
    for (const waiters of this.registrationWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(false);
      }
    }
    this.pending.clear();
    this.terminal.clear();
    this.registrationWaiters.clear();
  }
}

export async function createInteractionBrokerRuntime({
  host = "127.0.0.1",
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  registrationGraceMs = DEFAULT_REGISTRATION_GRACE_MS,
  terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
} = {}) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Interaction broker host must be loopback.");
  }
  const service = new InteractionBrokerService({
    maxWaitMs,
    registrationGraceMs,
    terminalTtlMs,
  });
  const token = crypto.randomBytes(32).toString("base64url");

  const server = http.createServer(async (request, response) => {
    // Let the business wait settle first so the plugin receives a structured
    // timeout response instead of an ambiguous socket reset.
    request.setTimeout(maxWaitMs + 5_000, () => request.destroy());
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { ok: false, error: "LOOPBACK_REQUIRED" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { ok: false, error: "UNAUTHORIZED" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/input") {
      sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
      return;
    }

    try {
      const body = await readJsonBody(request, maxRequestBytes);
      const record = body && typeof body === "object" ? body : null;
      const toolCallId = typeof record?.toolCallId === "string"
        ? record.toolCallId.trim()
        : "";
      if (!toolCallId) {
        sendJson(response, 400, { ok: false, error: "INVALID_REQUEST" });
        return;
      }
      const expireOnDisconnect = () => {
        if (!response.writableEnded) service.expire(toolCallId);
      };
      response.once("close", expireOnDisconnect);
      try {
        const answers = await service.waitForInput(toolCallId);
        sendJson(response, 200, { ok: true, answers });
      } finally {
        response.off("close", expireOnDisconnect);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, message === "REQUEST_TOO_LARGE" ? 413 : 409, {
        ok: false,
        error: message.replace(/\s+/g, " ").trim().slice(0, 160),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const url = `http://${host}:${address.port}`;
  let stopped = false;

  return {
    service,
    gatewayEnv: {
      ONECLAW_INTERACTION_BROKER_URL: url,
      ONECLAW_INTERACTION_BROKER_TOKEN: token,
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      service.close();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
