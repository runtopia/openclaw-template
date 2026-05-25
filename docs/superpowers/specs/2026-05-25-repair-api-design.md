# Repair API Design

Date: 2026-05-25

## Overview

Add repair capability directly into the Express wrapper so users can diagnose and fix OpenClaw errors through an external dashboard — even when the gateway is down. Provides REST endpoints for repair tools and an SSE streaming chat endpoint backed by an AI agent with full tool access.

## Goals

- Repair chat works as long as the container is alive (independent of gateway)
- AI uses the key that was valid at container startup (immune to user config changes)
- All endpoints protected by existing `SETUP_PASSWORD` auth
- Pure API — no new UI pages in this repo

## Architecture

### New file: `src/lib/routes/repair.js`

Mounted under `/setup` in `server.js`, inheriting `requireSetupAuth` middleware. Receives `repairAiKey` (key + baseUrl read at startup) and references to existing utilities (`runCmd`, `clawArgs`, `restartGateway`, `configFilePath`, `gatewayManager`).

### Change to `src/lib/gateway.js`

Switch gateway child process from `stdio: "inherit"` to piped stdout/stderr. Feed output into an in-memory ring buffer (500 lines max). Expose `getRecentLogs()` from the gateway manager. Logs still forwarded to `process.stdout` so existing container log behavior is unchanged.

### Change to `src/server.js`

At startup (after config is confirmed present), read the default provider key once into memory:

```js
const repairAiKey = readDefaultProviderKey(configFilePath());
```

`readDefaultProviderKey` reads `agents.defaults.model.primary` from `openclaw.json`, resolves the provider name, and returns `{ apiKey, baseUrl, model }` from `models.providers.<name>`. Returns `null` if config is absent or key cannot be resolved. This value is passed to `createRepairRouter` and never re-read.

## API Endpoints

All routes require `requireSetupAuth` (Basic auth, SETUP_PASSWORD).

### Repair Tools

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/setup/api/repair/status` | Gateway process state, uptime, readiness. Wraps existing `api/status` data. |
| `GET` | `/setup/api/repair/logs?n=100` | Last N lines from gateway ring buffer. Default 100, max 500. |
| `POST` | `/setup/api/repair/doctor` | Run `openclaw doctor --fix --yes`. Returns `{ ok, output }`. |
| `POST` | `/setup/api/repair/restart` | Call `restartGateway()`. Returns `{ ok }`. |
| `PATCH` | `/setup/api/repair/config` | Apply dot-path patches to `openclaw.json` via `patchConfig` + `setIn`. Body: `{ patches: { "gateway.auth.token": "...", ... } }`. Sensitive fields (`apiKey`, `token`, `secret`) are write-only — never returned. |

> Note: `POST /setup/api/doctor` already exists and is kept as-is. The new `/repair/doctor` runs `--fix --yes` (non-interactive) rather than `--repair`.

### Repair Chat

```
POST /setup/api/repair/chat
Content-Type: application/json

{ "messages": [{ "role": "user", "content": "gateway 启动失败，帮我排查" }] }
```

Response: `text/event-stream` (SSE)

#### SSE Event Types

```
data: {"type":"text","delta":"让我先看看日志…"}

data: {"type":"tool_call","name":"read_logs","input":{"n":50}}

data: {"type":"tool_result","name":"read_logs","output":"[gateway] failed to..."}

data: {"type":"text","delta":"找到问题了，正在修复…"}

data: {"type":"tool_call","name":"run_doctor","input":{}}

data: {"type":"tool_result","name":"run_doctor","output":"exit=0 ..."}

data: {"type":"done"}

data: {"type":"error","message":"..."}
```

#### Execution Loop

1. Open SSE connection, set `Content-Type: text/event-stream`
2. Call AI API (OpenAI-compatible) with tool definitions, streaming enabled
3. Stream text deltas → forward as `{"type":"text","delta":"..."}`
4. On tool call → execute locally → emit `tool_call` + `tool_result` events → append result to messages → continue
5. On AI finish → emit `{"type":"done"}` → close connection
6. On any error → emit `{"type":"error","message":"..."}` → close connection

Max 10 tool-call rounds per request to prevent infinite loops.

#### AI Key Resolution

`repairAiKey` is read once at container startup from `openclaw.json`:
- `agents.defaults.model.primary` → provider name (e.g. `clawrouters/auto` → `clawrouters`)
- `models.providers.<name>.{ apiKey, baseUrl }` → used for all chat requests
- If `null` (config not yet present), `/repair/chat` returns `503 { ok: false, reason: "no_key" }`

## AI Tools

Six tools exposed to the AI:

| Tool | Type | Description |
|------|------|-------------|
| `get_status` | read | Gateway process state, uptime, readiness flag |
| `read_logs` | read | Recent gateway log lines from ring buffer. Param: `n` (default 100) |
| `read_config` | read | Full `openclaw.json`, with all `apiKey`/`token`/`secret` values replaced by `"[REDACTED]"` |
| `run_doctor` | action | Execute `openclaw doctor --fix --yes`, return exit code + output |
| `restart_gateway` | action | Kill and restart gateway process |
| `patch_config` | action | Write specific fields to `openclaw.json` via dot-path. Input: `{ path: "gateway.auth.token", value: "..." }` |

## File Changes Summary

| File | Change |
|------|--------|
| `src/lib/routes/repair.js` | **New** — all repair endpoints + chat handler |
| `src/lib/gateway.js` | Pipe stdout/stderr → ring buffer, expose `getRecentLogs()` |
| `src/server.js` | Read `repairAiKey` at startup, pass to `createRepairRouter` |

## Security Notes

- `requireSetupAuth` on all endpoints — same SETUP_PASSWORD as setup wizard
- `read_config` always redacts sensitive fields before returning
- `patch_config` accepts writes to sensitive fields but never echoes them back
- Tool call rounds capped at 10 to prevent runaway loops
- `repairAiKey` held in memory only, never logged or returned in responses
