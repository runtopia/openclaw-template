# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This is a Railway deployment wrapper for **OpenClaw** (an AI coding assistant platform). v2 精简版：纯 env 驱动，无 setup 向导，无 tui。它提供：

- 自动从 env 生成 `openclaw.json` 配置（幂等，每次启动都跑）
- 反向代理：public URL → internal OpenClaw gateway（含 Bearer token 注入）
- `/login` 控制面板登录页（由 `SETUP_PASSWORD` 保护）
- `/repair/*` 修复助手（SSE chat + gateway RPC + QR 扫码绑定）
- 通过 Railway Volume `/data` 持久化状态

## Development Commands

```bash
# Local development (requires OpenClaw installed globally or OPENCLAW_ENTRY set)
npm run dev

# Production start
npm start

# Syntax check
npm run lint

# Run tests
node --test
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

# Access Control UI (after gateway starts)
open http://localhost:8080/openclaw  # password: test (via /login)
```

## Architecture

### Request Flow

1. **User → Railway → Wrapper (Express on PORT)** → routes to:
   - `/login` → 登录页（auth: `SETUP_PASSWORD`，设 session cookie）
   - `/repair/*` → 修复助手（需已登录或 Bearer secret）
   - All other routes → proxied to internal gateway（自动注入 `Authorization: Bearer <token>`）

2. **Wrapper → Gateway** (localhost:18789 by default)
   - HTTP/WebSocket reverse proxy via `http-proxy`
   - Automatically injects `Authorization: Bearer <token>` header

### Lifecycle States

1. **Auto-configure**: Wrapper reads env vars, writes `openclaw.json` (idempotent)
   - Spawns `openclaw gateway run` as child process
   - Waits for gateway to respond on multiple health endpoints
   - Proxies all traffic with injected bearer token

### Key Files

- **src/index.js** — 主入口：Express wrapper，加载所有路由，启动 gateway lifecycle
- **src/config/** — 配置生成：从 env 构建 `openclaw.json`（generate.js + runtime-defaults.js + plugins.js + edit.js）
  - `direct-config.js` — 核心配置构建，`buildHttpEndpoints()`、`applyRuntimeDefaults()`
  - `preinstalled-plugins.js` — 解析 `/opt/openclaw-plugins` 目录，生成 `plugins.load.paths`
- **src/gateway/** — Gateway 进程管理：`gateway.js`（spawn/restart/auto-heal）、`gateway-rpc.js`（持久 WS RPC 连接）
- **src/channels/** — 渠道配置写入（Telegram/Discord/Slack/飞书/WhatsApp/微信）
- **src/integration/** — OneClaw 平台集成（心跳、人格同步）
- **src/proxy/** — 反代与鉴权：`proxy.js`（http-proxy 封装）、`auth.js`（session + Bearer 双层鉴权）
- **src/repair/** — 修复助手路由：`assistant.js`（SSE chat）、`config-ops.js`（配置操作工具）、`qr-login.js`（WhatsApp/WeChat QR）
- **src/skills/** — AI 工具定义（repair assistant 工具集）
- **src/public/** — 静态页面：`login.html`（登录页）、`loading.html`（启动等待页）
- **start.sh** — Docker 启动脚本：修复 `/data` 权限 → gosu 降权 → `node /app/src/index.js`
- **Dockerfile** — 单阶段构建：安装 OpenClaw core、预装插件到 `/opt/openclaw-plugins`、安装 wrapper 依赖

### Environment Variables

**Required:**
- `SETUP_PASSWORD` — 保护 Control UI 登录页 `/login`（不填则无密码直接放行）

**Required (auto-configure):** at least one API key:
- `CLAWROUTERS_API_KEY` — ClawRouters 多模型路由（推荐）
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` etc.

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
  - All `/v1/*` HTTP endpoints default to **off** (verified against openclaw `server-http.ts`); `models`/`embeddings` ride on `openAiCompatEnabled` (true when either chat completions or responses is on). All still require `gateway.auth` Bearer token. Injected via `buildHttpEndpoints()` in `src/config/generate.js`, applied in the single env-driven config path.

### Authentication Flow

The wrapper manages a **two-layer auth scheme**:

1. **Control UI / repair auth**: Session cookie set at `/login` using `SETUP_PASSWORD` (src/proxy/auth.js)
2. **Gateway auth**: Bearer token (auto-generated or from `OPENCLAW_GATEWAY_TOKEN` env)
   - Token is auto-injected into proxied requests (src/proxy/reverse-proxy.js, `proxyReq` + `proxyReqWs` handlers)
   - Persisted to `${STATE_DIR}/gateway.token` if not provided via env (src/index.js)

### Gateway Token Injection

The wrapper **always** injects the bearer token into proxied requests so browser clients don't need to know it:

- HTTP requests: via `proxy.on("proxyReq")` event handler (src/proxy/reverse-proxy.js)
- WebSocket upgrades: via `proxy.on("proxyReqWs")` event handler (src/proxy/reverse-proxy.js)

**Important**: Token injection uses `http-proxy` event handlers (`proxyReq` and `proxyReqWs`) rather than direct `req.headers` modification. Direct header modification does not reliably work with WebSocket upgrades, causing intermittent `token_missing` or `token_mismatch` errors.

This allows the Control UI at `/openclaw` to work without user authentication.

## Common Development Tasks

### Testing authentication

- Login page: Clear browser cookies, visit `/openclaw` → should redirect to `/login`
- Gateway: Remove `Authorization` header injection (src/proxy/reverse-proxy.js) and verify requests fail

### Debugging gateway startup

Check logs for:
- `[gateway] starting with command: ...` (src/gateway/manager.js)
- `[gateway] ready at <endpoint>` (src/gateway/manager.js)
- `[gateway] failed to become ready after 20000ms` (src/gateway/manager.js)

If gateway doesn't start:
- Verify `openclaw.json` exists and is valid JSON
- Check `STATE_DIR` and `WORKSPACE_DIR` are writable
- Ensure bearer token is set in config

### Modifying channel configuration

Edit channel-specific env handling in `src/channels/` — each channel has its own module that writes config via `openclaw config set --json`.

### Adding new channel types

1. Add a new module in `src/channels/`
2. Add env var handling and config-writing logic
3. Wire it into config generation in `src/config/generate.js` (and the channel manifest in `src/channels/manifest.js`)

## Railway Deployment Notes

- Template must mount a volume at `/data`
- Must set `SETUP_PASSWORD` in Railway Variables (or omit for open access)
- Must set at least one API key (`CLAWROUTERS_API_KEY` recommended)
- Public networking must be enabled (assigns `*.up.railway.app` domain)
- OpenClaw is installed via the Dockerfile `OPENCLAW_VERSION` build arg (currently `2026.6.10`)

## Quirks & Gotchas

1. **Gateway token must be stable across redeploys** → persisted to volume if not in env
2. **Channels are written via `config set --json`, not `channels add`** → avoids CLI version incompatibilities
3. **Gateway readiness check polls multiple endpoints** (`/openclaw`, `/`, `/health`) → some builds only expose certain routes (src/gateway/manager.js)
4. **Discord bots require MESSAGE CONTENT INTENT** → document this in setup/onboarding UI if applicable
5. **Gateway stdout/stderr are piped, not inherited** → output is written to an in-memory ring buffer (500 lines, `src/gateway/manager.js`) via `appendLog()` and forwarded to `process.stdout`. Exposed as `getRecentLogs()` for the repair assistant's `read_logs` tool.
6. **Frontend clients connect directly to the gateway via WS reverse proxy (NOT multiplexed)** → Each browser tab gets its own gateway WS connection (`proxy.ws` + `proxyReqWs` injects `Authorization: Bearer <token>`, src/proxy/reverse-proxy.js). This is required: openclaw's `EventFrame` has no target-client field, so event routing relies on per-connection subscription state. A previous `ws-hub` multiplexer merged all clients into one gateway connection + answered `connect` locally with cached `helloOk` — which broke per-client event routing (cross-talk, broken subscriptions/presence/agent ops). 8 consecutive `fix(ws-hub)` commits couldn't patch it (architectural conflict); it was removed. The wrapper keeps ONE separate gateway WS connection (`src/gateway/rpc.js`, `createGatewayRpc`) only for its own RPCs (e.g. `/repair/whatsapp-login/*` forwarding `web.login.start`); `proxyReqWs` still injects the token + strips forwarded headers so the gateway treats proxied clients as trusted local.
7. **Control UI requires allowInsecureAuth to bypass pairing** → Set `gateway.controlUi.allowInsecureAuth=true` during onboarding to prevent "disconnected (1008): pairing required" errors (GitHub issue #2284). Wrapper already handles bearer token auth, so device pairing is unnecessary.
8. **Repair assistant's gateway restart MUST be non-blocking** → `restart_gateway` tool and `POST /repair/restart` call `restartGateway({ waitReady: false })`. The default `restartGateway()` awaits `waitForGatewayReady` (60s). If the repair assistant awaited readiness, a gateway that fails to start (the exact reason the user opened repair) would freeze the SSE chat for 60s then abort with an error. Non-blocking restart returns immediately; the AI then polls `get_status`/`read_logs`. The startup path (src/index.js `ensureGatewayRunning`) keeps the blocking default since it must confirm readiness before serving traffic.
9. **Gateway auto-heals on unexpected crash, but never on intentional stop** → `src/gateway/manager.js` exit handler auto-restarts with exponential backoff (capped at MAX_CRASH_RESTARTS=5, reset on successful readiness). `stopGateway`/`restartGateway`/graceful shutdown set `intentionalStop=true` so the handler skips self-heal — otherwise the auto-restart would fight graceful shutdown and the process could never exit. `startGateway` clears the flag on each new spawn so a stale `true` can't suppress a later genuine crash.
10. **Plugins are pre-baked into the image via `plugins.load.paths`, NOT `npm install -g`** → Verified against openclaw 2026.6.10 source (`discovery-*.js`): plugin discovery scans only bundled dir, `config/extensions`, `workspace/.openclaw/extensions`, `plugins.load.paths`, and managed install records — it does **NOT** scan global `node_modules`, so `npm install -g <plugin>` is invisible to OpenClaw. The old managed-install approach (`openclaw plugins install` → `$STATE_DIR/npm`) put plugins on the `/data` volume, which the mount shadows, forcing a ~650MB `cp` on every boot (~70s; see git 2740039). Instead the Dockerfile installs all plugins into `/opt/openclaw-plugins` (env `OPENCLAW_PLUGINS_DIR`, **outside** the volume); each plugin's deps nest under its own/adjacent `node_modules` (self-contained, ~0.5GB total). `src/config/plugins.js` resolves the existing package dirs and config generation (`src/config/generate.js`) writes them to `plugins.load.paths`. Result: zero runtime copy, zero runtime npm install, volume-mount-proof. `buildChannelPlan` gates on `availableChannels` (always true) instead of `channels add --help` — that help text doesn't list a plugin-backed channel until it's enabled, which would wrongly reject prebuilt channels. Activation still needs `plugins.entries.<id>.enabled=true` (auto-config sets clawrouters; channel plan sets the rest).
11. **Channel plugin facts (verified against openclaw 2026.6.10)** → **telegram** is built into openclaw core (`dist/extensions/telegram`) — no plugin to install. **slack/discord/feishu/whatsapp** are official standalone packages (`@openclaw/<name>`) and are pinned in the Dockerfile to `2026.6.10`. **feishu (飞书/Lark)** is `@openclaw/feishu`, channel id `feishu` (alias `lark`); earlier this repo used the third-party `@larksuite/openclaw-lark` (channel id `openclaw-lark`), which was replaced by official `@openclaw/feishu` so the channel is named `feishu`. When bumping feishu, re-verify minHostVersion ≤ host with `npm view @openclaw/feishu@<v> openclaw.install.minHostVersion`. **wechat (微信)** has NO official plugin; it uses the third-party `@tencent-weixin/openclaw-weixin`, whose channel id AND plugin id are both `openclaw-weixin` (pinned to `2.4.6`, requires openclaw >=2026.5.12). WeChat login is QR-based at runtime; the wrapper exposes it via `/repair/wechat-login/*`. clawrouters is GitHub-only (`github:runtopia/clawrouters-plugin`, id `clawrouters`), not on npm — another reason it must come via `plugins.load.paths` rather than lazy install.

12. **QR channel binding is per-channel — WhatsApp and WeChat use two different paths** → The QR is NOT in gateway stdout during normal channel runs. **WhatsApp** (`@openclaw/whatsapp`, baileys): the plugin sets `printQRInTerminal:false` and exposes the QR only via the gateway WS RPC `web.login.start` → `{ qrDataUrl }` (a `data:image/png;base64,...` PNG). The Control UI itself uses this (frontend var `whatsappLoginMessage`). The wrapper forwards it over its persistent gateway WS: `gatewayRpc.rpcGateway(method, params)` (src/gateway/rpc.js) issues a self-routed req and resolves the res, exposed as `POST /repair/whatsapp-login/start` and `/wait`. **WeChat** (`@tencent-weixin/openclaw-weixin@2.4.6`): the published npm package does not ship `/plugins/openclaw-weixin/*` HTTP routes by default, so the Dockerfile runs `scripts/patch-weixin-http-routes.js` after install to register `/qr-start`, `/qr-status`, and `/logout`. The wrapper calls `/qr-start` and `/qr-status` first so the repair API can return a QR URL immediately and retry a transient first failure. If the plugin HTTP route is unavailable (for example an unpatched image returns 404), the wrapper disables that fast path for the current process and falls back to `openclaw channels login --channel openclaw-weixin` stdout parsing. oneclaw_web's `QrBindModal` calls these endpoints (whatsapp→render qrDataUrl as `<img>`; wechat→render qrUrl with a QR library). QR session credentials persist under `STATE_DIR/credentials/` and `STATE_DIR/openclaw-weixin`.

13. **Runtime defaults are patched on every configured startup** → Fresh config generation and persisted-volume redeploys both run `applyRuntimeDefaults()` from `src/config/runtime-defaults.js`. It forces `agents.defaults.heartbeat={every:"2h",target:"last"}` and, when ClawRouters credentials are present, enables `agents.defaults.memorySearch` with provider `clawrouters`, model `auto`, sources `["memory","sessions"]`, and `remote.baseUrl` set to the ClawRouters `/api/v1` base. OpenClaw appends `/embeddings` internally, so do not write `/api/v1/embeddings` into config. The same patch enables the image-bundled `oneclaw-search` plugin and selects it at `tools.web.search` only when no other provider was selected; an explicit provider or `enabled=false` is preserved.

14. **WeChat access policy is image-patched** → `@tencent-weixin/openclaw-weixin@2.4.6` hardcodes pairing and originally treated an empty allow list as allowed. The Dockerfile runs `scripts/patch-weixin-access-policy.js` against the installed plugin so it reads `channels.openclaw-weixin.dmPolicy/allowFrom` and account overrides from `openclaw.json`. The patch also makes `allowFrom=["*"]` the only public-access wildcard; an empty list stays strict. When bumping the WeChat plugin, run `node --test test/weixin-access-policy-patch.test.js` and verify the Docker patch target still exists.
