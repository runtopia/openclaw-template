# OpenClaw Runtime Defaults Design

## Goal

Update the Railway template so fresh and existing `openclaw.json` files use the intended OneClaw defaults: two-hour agent heartbeats, ClawRouters-backed memory search, and OpenClaw `2026.6.11`.

## Requirements

- Generated configs keep `agents.defaults.heartbeat` at `{ "every": "2h", "target": "last" }`.
- Existing persisted configs are patched on startup/redeploy with the same heartbeat defaults.
- When `CLAWROUTERS_KEY` or `CLAWROUTERS_API_KEY` is present, memory search is enabled at `agents.defaults.memorySearch`.
- Memory search uses the ClawRouters provider, the ClawRouters secret env ref, and the ClawRouters `/api/v1` base URL. OpenClaw appends `/embeddings` internally, producing requests to `/api/v1/embeddings`.
- Memory search indexes both memory files and sessions by default.
- Docker installs `openclaw@2026.6.11` and aligns official `@openclaw/*` plugins to `2026.6.11`.

## Design

`src/lib/direct-config.js` will own the reusable runtime defaults. A new memory-search builder will produce the ClawRouters config only when ClawRouters credentials are available. A new patch helper will update existing configs in place, including the ClawRouters model provider base URL and memory-search remote base URL.

Startup paths that already patch existing `openclaw.json` files will call the shared helper:

- `src/init-config.js`
- `src/sidecar.js`
- `src/server.js`
- `src/lib/auto-config.js`

Fresh configs will call the same helper while building `agents.defaults`, so new and old instances converge on the same behavior.

## Testing

Node tests will cover:

- Fresh direct config generation includes heartbeat and ClawRouters memory search.
- Existing configs are patched with heartbeat, provider base URL, and memory-search remote settings.
- Base URL normalization remains `/api/v1`, not `/api/v1/embeddings`, because OpenClaw appends `/embeddings` itself.
