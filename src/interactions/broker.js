import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024;
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_REGISTRATION_GRACE_MS = 1_000;
const DEFAULT_TERMINAL_TTL_MS = 60 * 60 * 1000;
const SCHEMA_VERSION = 2;

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

function stableJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError("Interaction payload is not JSON-compatible.");
}

function digest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function requireString(value, field, maxLength = 200) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim().slice(0, maxLength);
}

function normalizeAttention(input, now, maxWaitMs) {
  const toolCallId = requireString(input?.toolCallId, "toolCallId", 128);
  const attentionId = requireString(
    input?.attentionId ?? `attention_${digest(toolCallId).slice(0, 32)}`,
    "attentionId",
    128,
  );
  const runId = requireString(input?.runId ?? "legacy_run", "runId", 128);
  const revision = input?.revision === undefined ? 1 : input.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("revision must be a positive integer.");
  }
  const expiresAt = input?.expiresAt === undefined ? now + maxWaitMs : input.expiresAt;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error("expiresAt must be a future epoch millisecond.");
  }
  const questions = input?.questions;
  if (questions !== undefined && (!Array.isArray(questions) || questions.length < 1 || questions.length > 4)) {
    throw new Error("questions must contain between one and four items.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    attentionId,
    toolCallId,
    runId,
    revision,
    kind: "business_input",
    title: typeof input?.title === "string" && input.title.trim()
      ? input.title.trim().slice(0, 200)
      : "Input required",
    ...(typeof input?.sessionKey === "string" && input.sessionKey.trim()
      ? { sessionKey: input.sessionKey.trim().slice(0, 500) }
      : {}),
    ...(questions ? { questions } : {}),
    expiresAt,
    createdAt: Number.isSafeInteger(input?.createdAt) ? input.createdAt : now,
    updatedAt: now,
  };
}

function rowView(row) {
  if (!row) return null;
  return {
    attentionId: String(row.attention_id),
    toolCallId: String(row.tool_call_id),
    runId: String(row.run_id),
    revision: Number(row.revision),
    kind: String(row.kind ?? "business_input"),
    status: String(row.status),
    title: String(row.title),
    ...(row.session_key ? { sessionKey: String(row.session_key) } : {}),
    ...(row.questions_json ? { questions: JSON.parse(String(row.questions_json)) } : {}),
    ...(row.answers_json ? { answers: JSON.parse(String(row.answers_json)) } : {}),
    ...(row.action_id ? { actionId: String(row.action_id) } : {}),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function attentionRequestHash(attention) {
  return digest({
    schemaVersion: attention.schemaVersion,
    attentionId: attention.attentionId,
    toolCallId: attention.toolCallId,
    runId: attention.runId,
    revision: attention.revision,
    kind: attention.kind,
    title: attention.title,
    ...(attention.sessionKey ? { sessionKey: attention.sessionKey } : {}),
    ...(attention.questions ? { questions: attention.questions } : {}),
  });
}

function attentionBusinessEvent(row) {
  if (!row?.questions_json) return null;
  const view = rowView(row);
  const type = `attention.${view.status === "pending" ? "created" : view.status}`;
  const payload = {
    kind: view.kind,
    status: view.status,
    title: view.title,
    questions: view.questions,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    expiresAt: view.expiresAt,
    ...(view.status === "resolved"
      ? {
          resolution: {
            ...(view.answers ? { answers: view.answers } : {}),
            ...(view.actionId ? { actionId: view.actionId } : {}),
            answeredAt: view.updatedAt,
          },
        }
      : {}),
  };
  return {
    type,
    producer: "attention",
    runId: view.runId,
    resourceId: view.attentionId,
    revision: view.revision,
    toolCallId: view.toolCallId,
    occurredAt: view.updatedAt,
    payload,
  };
}

export class InteractionBrokerService {
  constructor({
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    registrationGraceMs = DEFAULT_REGISTRATION_GRACE_MS,
    terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
    statePath = ":memory:",
    now = Date.now,
  } = {}) {
    this.maxWaitMs = maxWaitMs;
    this.registrationGraceMs = registrationGraceMs;
    this.terminalTtlMs = terminalTtlMs;
    this.now = now;
    this.waiters = new Map();
    this.registrationWaiters = new Map();
    this.statePath = statePath;
    if (statePath !== ":memory:") {
      fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    }
    this.database = new DatabaseSync(statePath);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA synchronous = FULL");
    if (statePath !== ":memory:") {
      const mode = this.database.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
      if (String(mode).toLowerCase() !== "wal") {
        this.database.close();
        throw new Error(`Interaction Broker SQLite refused WAL mode: ${String(mode)}`);
      }
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS broker_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS attentions (
        attention_id TEXT PRIMARY KEY,
        tool_call_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        session_key TEXT,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        kind TEXT NOT NULL DEFAULT 'business_input',
        status TEXT NOT NULL CHECK (status IN ('pending', 'resolved', 'expired', 'cancelled', 'lost')),
        title TEXT NOT NULL,
        questions_json TEXT,
        request_hash TEXT NOT NULL,
        answers_json TEXT,
        action_id TEXT,
        answer_hash TEXT,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS attentions_status_expiry
        ON attentions(status, expires_at);
      CREATE TABLE IF NOT EXISTS attention_events (
        idempotency_key TEXT PRIMARY KEY,
        attention_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        type TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        published_at INTEGER,
        FOREIGN KEY(attention_id) REFERENCES attentions(attention_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS attention_events_pending
        ON attention_events(published_at, created_at, idempotency_key);
      INSERT INTO broker_metadata(key, value)
      VALUES ('schema_version', '${SCHEMA_VERSION}')
      ON CONFLICT(key) DO NOTHING;
    `);
    let storedVersion = Number(this.database.prepare(
      "SELECT value FROM broker_metadata WHERE key = 'schema_version'",
    ).get()?.value);
    if (storedVersion === 1) {
      const columns = new Set(
        this.database.prepare("PRAGMA table_info(attentions)").all().map((column) => String(column.name)),
      );
      if (!columns.has("kind")) {
        this.database.exec(
          "ALTER TABLE attentions ADD COLUMN kind TEXT NOT NULL DEFAULT 'business_input'",
        );
      }
      if (!columns.has("action_id")) {
        this.database.exec("ALTER TABLE attentions ADD COLUMN action_id TEXT");
      }
      this.database.prepare(
        "UPDATE broker_metadata SET value = ? WHERE key = 'schema_version'",
      ).run(String(SCHEMA_VERSION));
      storedVersion = SCHEMA_VERSION;
    }
    if (storedVersion !== SCHEMA_VERSION) {
      this.database.close();
      throw new Error(`Unsupported Interaction Broker schema version: ${String(storedVersion)}`);
    }
    this.backfillAttentionEvents();
    this.sweepExpired();
    this.sweepTimer = setInterval(() => this.sweepExpired(), Math.min(30_000, Math.max(1_000, maxWaitMs)));
    this.sweepTimer.unref?.();
  }

  transaction(work) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  }

  getByToolCallId(toolCallId) {
    return this.database.prepare(
      "SELECT * FROM attentions WHERE tool_call_id = ?",
    ).get(toolCallId);
  }

  getByAttentionId(attentionId) {
    return this.database.prepare(
      "SELECT * FROM attentions WHERE attention_id = ?",
    ).get(attentionId);
  }

  enqueueAttentionEvent(row) {
    const event = attentionBusinessEvent(row);
    if (!event) return null;
    const idempotencyKey = `${event.resourceId}:${event.revision}:${event.type}`;
    this.database.prepare(`
      INSERT INTO attention_events (
        idempotency_key, attention_id, revision, type, event_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      idempotencyKey,
      event.resourceId,
      event.revision,
      event.type,
      JSON.stringify(event),
      event.occurredAt,
    );
    return idempotencyKey;
  }

  backfillAttentionEvents() {
    const rows = this.database.prepare(
      "SELECT * FROM attentions WHERE questions_json IS NOT NULL ORDER BY created_at, attention_id",
    ).all();
    for (const row of rows) this.enqueueAttentionEvent(row);
  }

  listPendingEvents(limit = 100) {
    const boundedLimit = Number.isSafeInteger(limit)
      ? Math.min(500, Math.max(1, limit))
      : 100;
    return this.database.prepare(`
      SELECT idempotency_key, event_json
        FROM attention_events
       WHERE published_at IS NULL
       ORDER BY created_at, idempotency_key
       LIMIT ?
    `).all(boundedLimit).map((row) => ({
      idempotencyKey: String(row.idempotency_key),
      event: JSON.parse(String(row.event_json)),
    }));
  }

  markEventPublished(idempotencyKey) {
    const normalized = requireString(idempotencyKey, "idempotencyKey", 500);
    const result = this.database.prepare(`
      UPDATE attention_events
         SET published_at = COALESCE(published_at, ?)
       WHERE idempotency_key = ?
    `).run(this.now(), normalized);
    return Number(result.changes) > 0;
  }

  createAttention(input) {
    const now = this.now();
    const attention = normalizeAttention(input, now, this.maxWaitMs);
    const requestHash = attentionRequestHash(attention);
    const result = this.transaction(() => {
      const existing = this.database.prepare(
        "SELECT * FROM attentions WHERE attention_id = ? OR tool_call_id = ? LIMIT 1",
      ).get(attention.attentionId, attention.toolCallId);
      if (existing) {
        if (
          String(existing.attention_id) === attention.attentionId
          && String(existing.tool_call_id) === attention.toolCallId
          && String(existing.request_hash) === requestHash
        ) {
          this.enqueueAttentionEvent(existing);
          return { created: false, duplicate: true, attention: rowView(existing) };
        }
        return {
          created: false,
          duplicate: false,
          code: "INTERACTION_CONFLICT",
          protocolCode: "revision_conflict",
          attention: rowView(existing),
        };
      }
      this.database.prepare(`
        INSERT INTO attentions (
          attention_id, tool_call_id, run_id, session_key, revision, kind, status,
          title, questions_json, request_hash, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `).run(
        attention.attentionId,
        attention.toolCallId,
        attention.runId,
        attention.sessionKey ?? null,
        attention.revision,
        attention.kind,
        attention.title,
        attention.questions ? JSON.stringify(attention.questions) : null,
        requestHash,
        attention.expiresAt,
        attention.createdAt,
        attention.updatedAt,
      );
      const created = this.getByAttentionId(attention.attentionId);
      this.enqueueAttentionEvent(created);
      return {
        created: true,
        duplicate: false,
        attention: rowView(created),
      };
    });
    this.notifyRegistered(attention.toolCallId);
    return result;
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
    if (this.getByToolCallId(toolCallId)) return Promise.resolve(true);
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

  waitForInput(input) {
    const toolCallId = typeof input === "string"
      ? requireString(input, "toolCallId", 128)
      : requireString(input?.toolCallId, "toolCallId", 128);
    let row = this.getByToolCallId(toolCallId);
    if (!row) {
      this.createAttention(typeof input === "string" ? { toolCallId } : input);
      row = this.getByToolCallId(toolCallId);
    }
    if (!row) throw new Error("INTERACTION_NOT_FOUND");
    if (Number(row.expires_at) <= this.now() && String(row.status) === "pending") {
      this.expire(toolCallId, "INPUT_REQUEST_TIMED_OUT");
      row = this.getByToolCallId(toolCallId);
    }
    if (String(row.status) === "resolved") {
      if (row.answers_json) {
        return Promise.resolve(JSON.parse(String(row.answers_json)));
      }
      return Promise.reject(new Error("INPUT_REQUEST_ALREADY_ANSWERED"));
    }
    if (String(row.status) !== "pending") {
      return Promise.reject(new Error("INPUT_REQUEST_TIMED_OUT"));
    }

    const existing = this.waiters.get(toolCallId);
    if (existing) {
      clearTimeout(existing.timeout);
      existing.reject(new Error("INPUT_REQUEST_REPLACED"));
    }
    const remaining = Math.max(1, Math.min(this.maxWaitMs, Number(row.expires_at) - this.now()));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.waiters.get(toolCallId)?.timeout !== timeout) return;
        this.waiters.delete(toolCallId);
        this.expire(toolCallId, "INPUT_REQUEST_TIMED_OUT");
        reject(new Error("INPUT_REQUEST_TIMED_OUT"));
      }, remaining);
      timeout.unref?.();
      this.waiters.set(toolCallId, { resolve, reject, timeout });
      this.notifyRegistered(toolCallId);
    });
  }

  submit({ runId, toolCallId, attentionId, expectedRevision, answers }, { detailed = false } = {}) {
    const formatResult = (result) => {
      if (detailed) return result;
      const { attention: _attention, protocolCode: _protocolCode, ...legacyResult } = result;
      return legacyResult;
    };
    const normalizedRunId = requireString(runId, "runId", 128);
    const normalizedAnswers = Array.isArray(answers) ? answers : null;
    if (!normalizedAnswers) {
      return formatResult({
        success: false,
        code: "INVALID_ANSWERS",
        protocolCode: "invalid_payload",
      });
    }
    let row = attentionId
      ? this.getByAttentionId(requireString(attentionId, "attentionId", 128))
      : this.getByToolCallId(requireString(toolCallId, "toolCallId", 128));
    if (!row) {
      return formatResult({
        success: false,
        code: "INTERACTION_NOT_FOUND",
        protocolCode: "run_not_active",
      });
    }
    const resolvedToolCallId = String(row.tool_call_id);
    if (String(row.status) === "pending" && Number(row.expires_at) <= this.now()) {
      this.expire(resolvedToolCallId, "INPUT_REQUEST_TIMED_OUT");
      row = this.getByToolCallId(resolvedToolCallId);
    }
    if (String(row.status) === "expired" || String(row.status) === "cancelled" || String(row.status) === "lost") {
      return formatResult({
        success: false,
        code: "INTERACTION_EXPIRED",
        protocolCode: "run_not_active",
      });
    }
    const answerHash = digest(normalizedAnswers);
    if (String(row.status) === "resolved") {
      if (String(row.run_id) === normalizedRunId && String(row.answer_hash) === answerHash) {
        return formatResult({
          success: true,
          status: "already_submitted",
          attention: rowView(row),
        });
      }
      return formatResult({
        success: false,
        code: "INTERACTION_ALREADY_ANSWERED",
        protocolCode: "revision_conflict",
        attention: rowView(row),
      });
    }
    if (String(row.run_id) === "legacy_run" && String(row.status) === "pending") {
      this.database.prepare(
        "UPDATE attentions SET run_id = ?, updated_at = ? WHERE attention_id = ? AND run_id = 'legacy_run'",
      ).run(normalizedRunId, this.now(), String(row.attention_id));
      row = this.getByAttentionId(String(row.attention_id));
    }
    if (String(row.run_id) !== normalizedRunId) {
      return formatResult({
        success: false,
        code: "INTERACTION_OWNERSHIP_MISMATCH",
        protocolCode: "ownership_mismatch",
      });
    }
    if (
      expectedRevision !== undefined
      && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== Number(row.revision))
    ) {
      return formatResult({
        success: false,
        code: "INTERACTION_REVISION_CONFLICT",
        protocolCode: "revision_conflict",
        attention: rowView(row),
      });
    }

    const now = this.now();
    const updated = this.transaction(() => {
      const resolved = this.database.prepare(`
        UPDATE attentions
           SET status = 'resolved',
               revision = revision + 1,
               answers_json = ?,
               answer_hash = ?,
               updated_at = ?
         WHERE attention_id = ?
           AND status = 'pending'
           AND revision = ?
        RETURNING *
      `).get(
        JSON.stringify(normalizedAnswers),
        answerHash,
        now,
        String(row.attention_id),
        Number(row.revision),
      );
      if (resolved) this.enqueueAttentionEvent(resolved);
      return resolved;
    });
    if (!updated) {
      return this.submit(
        { runId, toolCallId: resolvedToolCallId, attentionId, expectedRevision, answers },
        { detailed },
      );
    }
    const waiter = this.waiters.get(resolvedToolCallId);
    if (waiter) {
      clearTimeout(waiter.timeout);
      this.waiters.delete(resolvedToolCallId);
      waiter.resolve(normalizedAnswers);
    }
    return formatResult({
      success: true,
      status: "submitted",
      attention: rowView(updated),
    });
  }

  async submitWhenReady(payload, options) {
    const immediate = this.submit(payload, options);
    if (immediate.code !== "INTERACTION_NOT_FOUND") return immediate;
    const toolCallId = requireString(payload?.toolCallId, "toolCallId", 128);
    await this.waitForRegistration(toolCallId);
    return this.submit(payload, options);
  }

  detachWaiter(toolCallId, reason = "INPUT_REQUEST_DISCONNECTED") {
    const normalized = requireString(toolCallId, "toolCallId", 128);
    const waiter = this.waiters.get(normalized);
    if (!waiter) return false;
    clearTimeout(waiter.timeout);
    this.waiters.delete(normalized);
    waiter.reject(new Error(reason));
    return true;
  }

  expire(toolCallId, reason = "INPUT_REQUEST_CANCELLED", status = "expired") {
    const normalized = requireString(toolCallId, "toolCallId", 128);
    const now = this.now();
    const row = this.transaction(() => {
      const expired = this.database.prepare(`
        UPDATE attentions
           SET status = ?,
               revision = revision + 1,
               updated_at = ?
         WHERE tool_call_id = ?
           AND status = 'pending'
        RETURNING *
      `).get(status, now, normalized);
      if (expired) this.enqueueAttentionEvent(expired);
      return expired;
    });
    if (!row) return false;
    const waiter = this.waiters.get(normalized);
    if (waiter) {
      clearTimeout(waiter.timeout);
      this.waiters.delete(normalized);
      waiter.reject(new Error(reason));
    }
    return true;
  }

  listPending() {
    this.sweepExpired();
    return this.database.prepare(
      "SELECT * FROM attentions WHERE status = 'pending' ORDER BY created_at, attention_id",
    ).all().map(rowView);
  }

  listUpdatedSince(updatedAt = 0) {
    return this.database.prepare(
      "SELECT * FROM attentions WHERE updated_at >= ? ORDER BY updated_at, attention_id",
    ).all(updatedAt).map(rowView);
  }

  sweepExpired() {
    const now = this.now();
    const rows = this.database.prepare(
      "SELECT tool_call_id FROM attentions WHERE status = 'pending' AND expires_at <= ?",
    ).all(now);
    for (const row of rows) {
      this.expire(String(row.tool_call_id), "INPUT_REQUEST_TIMED_OUT");
    }
    if (this.terminalTtlMs > 0) {
      this.database.prepare(
        `DELETE FROM attentions
          WHERE status != 'pending'
            AND updated_at < ?
            AND NOT EXISTS (
              SELECT 1
                FROM attention_events
               WHERE attention_events.attention_id = attentions.attention_id
                 AND attention_events.published_at IS NULL
            )`,
      ).run(now - this.terminalTtlMs);
    }
  }

  close() {
    clearInterval(this.sweepTimer);
    for (const entry of this.waiters.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error("BROKER_SHUTDOWN"));
    }
    for (const waiters of this.registrationWaiters.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.resolve(false);
      }
    }
    this.waiters.clear();
    this.registrationWaiters.clear();
    if (this.statePath !== ":memory:") {
      this.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
    }
    this.database.close();
  }
}

export async function createInteractionBrokerRuntime({
  host = "127.0.0.1",
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  registrationGraceMs = DEFAULT_REGISTRATION_GRACE_MS,
  terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
  statePath = ":memory:",
} = {}) {
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error("Interaction broker host must be loopback.");
  }
  const service = new InteractionBrokerService({
    maxWaitMs,
    registrationGraceMs,
    terminalTtlMs,
    statePath,
  });
  const token = crypto.randomBytes(32).toString("base64url");

  const server = http.createServer(async (request, response) => {
    request.setTimeout(maxWaitMs + 5_000, () => request.destroy());
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      sendJson(response, 403, { ok: false, error: "LOOPBACK_REQUIRED" });
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { ok: false, error: "UNAUTHORIZED" });
      return;
    }

    try {
      if (request.method === "GET" && request.url === "/v1/events/pending") {
        sendJson(response, 200, { ok: true, events: service.listPendingEvents() });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/attentions/pending") {
        sendJson(response, 200, { ok: true, attentions: service.listPending() });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
        return;
      }
      const body = await readJsonBody(request, maxRequestBytes);
      if (request.url === "/v1/events/ack") {
        const published = service.markEventPublished(body?.idempotencyKey);
        sendJson(response, published ? 200 : 404, {
          ok: published,
          ...(published ? {} : { error: "EVENT_NOT_FOUND" }),
        });
        return;
      }
      if (request.url === "/v1/attentions") {
        const result = service.createAttention(body);
        sendJson(response, result.code ? 409 : 200, {
          ok: !result.code,
          ...result,
        });
        return;
      }
      if (request.url === "/v1/attentions/respond") {
        const result = await service.submitWhenReady(body, { detailed: true });
        sendJson(response, result.success ? 200 : 409, {
          ok: result.success,
          ...result,
        });
        return;
      }
      if (request.url !== "/v1/input") {
        sendJson(response, 404, { ok: false, error: "NOT_FOUND" });
        return;
      }

      const toolCallId = typeof body?.toolCallId === "string"
        ? body.toolCallId.trim()
        : "";
      if (!toolCallId) {
        sendJson(response, 400, { ok: false, error: "INVALID_REQUEST" });
        return;
      }
      const expireOnDisconnect = () => {
        if (!response.writableEnded) service.detachWaiter(toolCallId);
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
