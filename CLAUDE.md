# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Railway deployment wrapper for **OpenClaw** (an AI coding assistant platform). It provides:

- A web-based setup wizard at `/setup` (protected by `SETUP_PASSWORD`)
- Automatic reverse proxy from public URL → internal OpenClaw gateway
- Persistent state via Railway Volume at `/data`

The wrapper manages the OpenClaw lifecycle: onboarding → gateway startup → traffic proxying.

## Development Commands

```bash
# Local development (requires OpenClaw installed globally or OPENCLAW_ENTRY set)
npm run dev

# Production start
npm start

# Syntax check
npm run lint
```

## Docker Build & Local Testing

```bash
# Build the container
docker build -t openclaw-railway-template .

# Run locally with volume
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# Access setup wizard
open http://localhost:8080/setup  # password: test
```

## Architecture

### Request Flow

1. **User → Railway → Wrapper (Express on PORT)** → routes to:
   - `/setup/*` → setup wizard (auth: Basic with `SETUP_PASSWORD`)
   - All other routes → proxied to internal gateway

2. **Wrapper → Gateway** (localhost:18789 by default)
   - HTTP/WebSocket reverse proxy via `http-proxy`
   - Automatically injects `Authorization: Bearer <token>` header

### Lifecycle States

1. **Unconfigured**: No `openclaw.json` exists
   - All non-`/setup` routes redirect to `/setup`
   - User completes setup wizard → runs `openclaw onboard --non-interactive`

2. **Configured**: `openclaw.json` exists
   - Wrapper spawns `openclaw gateway run` as child process
   - Waits for gateway to respond on multiple health endpoints
   - Proxies all traffic with injected bearer token

### Key Files

- **src/server.js** (main entry): Express wrapper, proxy setup, gateway lifecycle management, configuration persistence (server logic only - no inline HTML/CSS)
- **src/public/** (static assets for setup wizard):
  - **setup.html**: Setup wizard HTML structure
  - **styles.css**: Setup wizard styling (extracted from inline styles)
  - **setup-app.js**: Client-side JS for `/setup` wizard (vanilla JS, no build step)
- **Dockerfile**: Single-stage build (installs OpenClaw via npm, installs wrapper deps)

### Environment Variables

**Required:**
- `SETUP_PASSWORD` — protects `/setup` wizard

**Recommended (Railway template defaults):**
- `OPENCLAW_STATE_DIR=/data/.openclaw` — config + credentials
- `OPENCLAW_WORKSPACE_DIR=/data/workspace` — agent workspace

**Optional:**
- `OPENCLAW_GATEWAY_TOKEN` — auth token for gateway (auto-generated if unset)
- `PORT` — wrapper HTTP port (default 8080)
- `INTERNAL_GATEWAY_PORT` — gateway internal port (default 18789)
- `OPENCLAW_ENTRY` — path to `entry.js` (default `/usr/local/lib/node_modules/openclaw/dist/entry.js`)
- `GATEWAY_CHAT_COMPLETIONS_ENABLED` — enable `POST /v1/chat/completions` (also exposes `GET /v1/models` + `POST /v1/embeddings`, which have no independent switch). Default: off
- `GATEWAY_RESPONSES_ENABLED` — enable `POST /v1/responses` (independent of chat completions). Default: off
  - All `/v1/*` HTTP endpoints default to **off** (verified against openclaw `server-http.ts`); `models`/`embeddings` ride on `openAiCompatEnabled` (true when either chat completions or responses is on). All still require `gateway.auth` Bearer token. Injected via `buildHttpEndpoints()` in `src/lib/direct-config.js`, applied across all three config paths (direct-config / auto-config / setup wizard).

### Authentication Flow

The wrapper manages a **two-layer auth scheme**:

1. **Setup wizard auth**: Basic auth with `SETUP_PASSWORD` (src/server.js:190)
2. **Gateway auth**: Bearer token (auto-generated or from `OPENCLAW_GATEWAY_TOKEN` env)
   - Token is auto-injected into proxied requests (src/server.js:736, src/server.js:741)
   - Persisted to `${STATE_DIR}/gateway.token` if not provided via env (src/server.js:25-48)

### Onboarding Process

When the user runs setup (src/server.js:522-693):

1. Calls `openclaw onboard --non-interactive` with user-selected auth provider
2. Writes channel configs (Telegram/Discord/Slack) directly to `openclaw.json` via `openclaw config set --json`
3. Force-sets gateway config to use token auth + loopback bind + allowInsecureAuth
4. Spawns gateway process
5. Waits for gateway readiness (polls multiple endpoints)

**Important**: Channel setup bypasses `openclaw channels add` and writes config directly because `channels add` is flaky across different OpenClaw builds.

### Gateway Token Injection

The wrapper **always** injects the bearer token into proxied requests so browser clients don't need to know it:

- HTTP requests: via `proxy.on("proxyReq")` event handler (src/server.js:736)
- WebSocket upgrades: via `proxy.on("proxyReqWs")` event handler (src/server.js:741)

**Important**: Token injection uses `http-proxy` event handlers (`proxyReq` and `proxyReqWs`) rather than direct `req.headers` modification. Direct header modification does not reliably work with WebSocket upgrades, causing intermittent `token_missing` or `token_mismatch` errors.

This allows the Control UI at `/openclaw` to work without user authentication.

## Common Development Tasks

### Testing the setup wizard

1. Delete `${STATE_DIR}/openclaw.json` (or run Reset in the UI)
2. Visit `/setup` and complete onboarding
3. Check logs for gateway startup and channel config writes

### Testing authentication

- Setup wizard: Clear browser auth, verify Basic auth challenge
- Gateway: Remove `Authorization` header injection (src/server.js:736) and verify requests fail

### Debugging gateway startup

Check logs for:
- `[gateway] starting with command: ...` (src/server.js:142)
- `[gateway] ready at <endpoint>` (src/server.js:100)
- `[gateway] failed to become ready after 20000ms` (src/server.js:109)

If gateway doesn't start:
- Verify `openclaw.json` exists and is valid JSON
- Check `STATE_DIR` and `WORKSPACE_DIR` are writable
- Ensure bearer token is set in config

### Modifying onboarding args

Edit `buildOnboardArgs()` (src/server.js:442-496) to add new CLI flags or auth providers.

### Adding new channel types

1. Add channel-specific fields to `/setup` HTML (src/public/setup.html)
2. Add config-writing logic in `/setup/api/run` handler (src/server.js)
3. Update client JS to collect the fields (src/public/setup-app.js)

## Railway Deployment Notes

- Template must mount a volume at `/data`
- Must set `SETUP_PASSWORD` in Railway Variables
- Public networking must be enabled (assigns `*.up.railway.app` domain)
- OpenClaw is installed via the Dockerfile `OPENCLAW_VERSION` build arg (currently `2026.6.10`)

## Serena Semantic Coding

This project has been onboarded with **Serena** (semantic coding assistant via MCP). Comprehensive memory files are available covering:

- Project overview and architecture
- Tech stack and codebase structure
- Code style and conventions
- Development commands and task completion checklist
- Quirks and gotchas

**When working on tasks:**
1. Check `mcp__serena__check_onboarding_performed` first to see available memories
2. Read relevant memory files before diving into code (e.g., `mcp__serena__read_memory`)
3. Use Serena's semantic tools for efficient code exploration:
   - `get_symbols_overview` - Get high-level file structure without reading entire file
   - `find_symbol` - Find classes, functions, methods by name path
   - `find_referencing_symbols` - Understand dependencies and usage
4. Prefer symbolic editing (`replace_symbol_body`, `insert_after_symbol`) for precise modifications

This avoids repeatedly reading large files and provides instant context about the project.

## Quirks & Gotchas

1. **Gateway token must be stable across redeploys** → persisted to volume if not in env
2. **Channels are written via `config set --json`, not `channels add`** → avoids CLI version incompatibilities
3. **Gateway readiness check polls multiple endpoints** (`/openclaw`, `/`, `/health`) → some builds only expose certain routes (src/server.js:92)
4. **Discord bots require MESSAGE CONTENT INTENT** → document this in setup wizard (src/server.js:295-298)
5. **Gateway stdout/stderr are piped, not inherited** → output is written to an in-memory ring buffer (500 lines, `gateway.js`) via `appendLog()` and forwarded to `process.stdout`. Exposed as `getRecentLogs()` for the repair assistant's `read_logs` tool.
6. **Frontend clients connect directly to the gateway via WS reverse proxy (NOT multiplexed)** → Each browser tab gets its own gateway WS connection (`proxy.ws` + `proxyReqWs` injects `Authorization: Bearer <token>`, src/sidecar.js + src/server.js). This is required: openclaw's `EventFrame` has no target-client field, so event routing relies on per-connection subscription state. A previous `ws-hub` multiplexer merged all clients into one gateway connection + answered `connect` locally with cached `helloOk` — which broke per-client event routing (cross-talk, broken subscriptions/presence/agent ops). 8 consecutive `fix(ws-hub)` commits couldn't patch it (architectural conflict); it was removed. The wrapper keeps ONE separate gateway WS connection (`src/lib/gateway-rpc.js`, `createGatewayRpc`) only for its own RPCs (e.g. `/repair/whatsapp-login/*` forwarding `web.login.start`); `proxyReqWs` still injects the token + strips forwarded headers so the gateway treats proxied clients as trusted local.
7. **Control UI requires allowInsecureAuth to bypass pairing** → Set `gateway.controlUi.allowInsecureAuth=true` during onboarding to prevent "disconnected (1008): pairing required" errors (GitHub issue #2284). Wrapper already handles bearer token auth, so device pairing is unnecessary.
8. **Repair assistant's gateway restart MUST be non-blocking** → `restart_gateway` tool and `POST /repair/restart` call `restartGateway({ waitReady: false })`. The default `restartGateway()` awaits `waitForGatewayReady` (60s). If the repair assistant awaited readiness, a gateway that fails to start (the exact reason the user opened repair) would freeze the SSE chat for 60s then abort with an error. Non-blocking restart returns immediately; the AI then polls `get_status`/`read_logs`. The setup wizard (src/lib/routes/setup.js) keeps the blocking default since it must confirm readiness before responding.
9. **Gateway auto-heals on unexpected crash, but never on intentional stop** → `gateway.js` exit handler auto-restarts with exponential backoff (capped at MAX_CRASH_RESTARTS=5, reset on successful readiness). `stopGateway`/`restartGateway`/graceful shutdown set `intentionalStop=true` so the handler skips self-heal — otherwise the auto-restart would fight graceful shutdown and the process could never exit. `startGateway` clears the flag on each new spawn so a stale `true` can't suppress a later genuine crash.
10. **Plugins are pre-baked into the image via `plugins.load.paths`, NOT `npm install -g`** → Verified against openclaw 2026.6.10 source (`discovery-*.js`): plugin discovery scans only bundled dir, `config/extensions`, `workspace/.openclaw/extensions`, `plugins.load.paths`, and managed install records — it does **NOT** scan global `node_modules`, so `npm install -g <plugin>` is invisible to OpenClaw. The old managed-install approach (`openclaw plugins install` → `$STATE_DIR/npm`) put plugins on the `/data` volume, which the mount shadows, forcing a ~650MB `cp` on every boot (~70s; see git 2740039). Instead the Dockerfile installs all plugins into `/opt/openclaw-plugins` (env `OPENCLAW_PLUGINS_DIR`, **outside** the volume); each plugin's deps nest under its own/adjacent `node_modules` (self-contained, ~0.5GB total). `src/lib/preinstalled-plugins.js` resolves the existing package dirs and both auto-config + setup write them to `plugins.load.paths`. Result: zero runtime copy, zero runtime npm install, volume-mount-proof. The setup wizard's `plugins install` loop is now a dev-only fallback (skipped when prebuilts exist), and `buildChannelPlan` gates on `availableChannels` (always true) instead of `channels add --help` — that help text doesn't list a plugin-backed channel until it's enabled, which would wrongly reject prebuilt channels. Activation still needs `plugins.entries.<id>.enabled=true` (auto-config sets clawrouters; channel plan sets the rest).
11. **Channel plugin facts (verified against openclaw 2026.6.10)** → **telegram** is built into openclaw core (`dist/extensions/telegram`) — no plugin to install. **slack/discord/feishu/whatsapp** are official standalone packages (`@openclaw/<name>`) and are pinned in the Dockerfile to `2026.6.10`. **feishu (飞书/Lark)** is `@openclaw/feishu`, channel id `feishu` (alias `lark`); `@openclaw/feishu@2026.6.10` declares `openclaw.install.minHostVersion: ">=2026.5.29"`, which is satisfied by `openclaw@2026.6.10`. Earlier this repo used the third-party `@larksuite/openclaw-lark` (channel id `openclaw-lark`); that was replaced by official `@openclaw/feishu` so the channel is named `feishu`. When bumping feishu, re-verify minHostVersion ≤ host with `npm view @openclaw/feishu@<v> openclaw.install.minHostVersion`. **wechat (微信)** has NO official plugin; it uses the third-party `@tencent-weixin/openclaw-weixin`, whose channel id AND plugin id are both `openclaw-weixin` (pinned to `2.4.6`, requires openclaw >=2026.5.12). WeChat login is QR-based at runtime (`openclaw channels login --channel openclaw-weixin`), so the wizard only enables the channel; the user scans the QR via the repair console / logs afterward. The wizard's old "webchat" option was removed (it was the embeddable web widget, not WeChat). clawrouters is GitHub-only (`github:runtopia/clawrouters-plugin`, id `clawrouters`), not on npm — another reason it must come via `plugins.load.paths` rather than lazy install.

12. **QR channel binding is per-channel — WhatsApp and WeChat use two completely different paths** → The QR is NOT in gateway stdout during normal channel runs. **WhatsApp** (`@openclaw/whatsapp`, baileys): the plugin sets `printQRInTerminal:false` and exposes the QR only via the gateway WS RPC `web.login.start` → `{ qrDataUrl }` (a `data:image/png;base64,...` PNG). The Control UI itself uses this (frontend var `whatsappLoginMessage`). The wrapper forwards it over its persistent gateway WS: `gatewayRpc.rpcGateway(method, params)` (src/lib/gateway-rpc.js) issues a self-routed req and resolves the res, exposed as `POST /repair/whatsapp-login/start` and `/wait`. **WeChat** (`@tencent-weixin/openclaw-weixin`): no web RPC at all — the QR is printed to stdout ONLY by `openclaw channels login --channel openclaw-weixin`, as an ASCII block PLUS a raw URL (`https://liteapp.weixin.qq.com/q/<id>?qrcode=...&bot_type=3`). `src/lib/wechat-login.js` spawns that CLI as a single managed process, parses stdout for the qrUrl + a connected marker, exposed as `POST /repair/wechat-login/start` + `GET /repair/wechat-login`. The two paths don't conflict (web.login.start is single-provider but only WhatsApp registers it; WeChat uses the separate CLI). Verified against openclaw 2026.6.10 source + local gateway/WC test. oneclaw_web's `QrBindModal` calls these endpoints (whatsapp→render qrDataUrl as `<img>`; wechat→render qrUrl with a QR library). QR session credentials persist under `STATE_DIR/credentials/` (so the `start.sh` STATE_DIR-on-volume fix is what keeps a scanned binding alive across redeploys).

13. **WeChat access policy is image-patched** → `@tencent-weixin/openclaw-weixin@2.4.6` hardcodes pairing and originally treated an empty allow list as allowed. The Dockerfile runs `scripts/patch-weixin-access-policy.js` against the installed plugin so it reads `channels.openclaw-weixin.dmPolicy/allowFrom` and account overrides from `openclaw.json`. The patch also makes `allowFrom=["*"]` the only public-access wildcard; an empty list stays strict. When bumping the WeChat plugin, run `node --test test/weixin-access-policy-patch.test.js` and verify the Docker patch target still exists.
