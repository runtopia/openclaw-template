# OpenClaw Railway Template

Deploy **OpenClaw** (an AI coding assistant platform) on Railway as a single container. Configuration is fully env-driven — no setup wizard, no web terminal. The [oneclaw_web](https://www.oneclaw.net) SaaS console manages deployment and onboarding per user.

## What you get

- **OpenClaw Gateway + Control UI** at `/openclaw`
- **Reverse proxy** on `PORT` with automatic Bearer token injection
- **Persistent state** via Railway Volume (`/data`) — config, credentials, and memory survive redeploys
- **Semantic memory search** backed by ClawRouters embeddings when a ClawRouters child key is present
- **OneClaw web search** routed through ClawRouters with server-side SearXNG/Tavily fallback
- **Realtime voice Talk + TTS** routed through ClawRouters without exposing the child key to the browser
- **Repair console** at `/repair/*` — AI diagnostic chat, gateway restart, QR binding for WhatsApp/WeChat
- **Health endpoint** at `/health`
- **Login page** at `/login` (protected by `SETUP_PASSWORD`)
- **Pinned common skills** from OneClaw Desktop, including in-chat message-channel setup and the document runtime in the standard image

The default Docker build uses the `standard` runtime profile. It contains the
Gateway, channels, common media tools, and PDF/XLSX/DOCX/PPTX runtimes. Build
with `--build-arg ONECLAW_RUNTIME_PROFILE=full` for the additive browser and
specialist CLI toolchain. The standard profile uses the broad local `pdf` workflow; legacy employee
assignments of the paid-Gemini-dependent `nano-pdf` skill are mapped to `pdf`.
The specialized `nano-pdf` executable remains available only in `full`.

Generated media stays workspace-scoped for every configured employee. The
image applies a fail-closed OpenClaw patch that lets an authenticated
`assistant-media` request select a configured `agentId`; OpenClaw then adds
only that agent's declared workspace root instead of exposing arbitrary local
paths.

## Architecture

```
User Request
  ↓
Wrapper (Express on PORT)
  ├─ /health         → liveness probe
  ├─ /login          → Control UI login page (auth: SETUP_PASSWORD)
  ├─ /repair/*       → repair assistant (session or Bearer; runtime input requires instance Bearer)
  └─ all other       → reverse-proxied to openclaw gateway (Bearer token auto-injected)
```

### Lifecycle

1. **Startup**: the wrapper listens immediately, fetches the OneClaw profile with a 750ms upper bound, idempotently preloads existing Agent identity/SOUL/memory into config and workspace, then starts `openclaw gateway`. The Gateway therefore boots with the final personality instead of running an interactive setup or duplicate file RPCs after readiness.
2. **Runtime**: OpenClaw hot-reloads Agent, model, key, channel, and binding changes without restarting the Gateway. Only explicit restart operations restart it. Unexpected crashes still auto-heal with exponential backoff.
3. **Repair**: `/repair/*` endpoints let oneclaw_web's panel (or direct API calls) run AI diagnostics, restart the gateway, or trigger QR binding flows for WhatsApp/WeChat.

### ClawRouters runtime defaults

With `CLAWROUTERS_API_KEY`, fresh and existing instances converge on the same runtime defaults at every startup:

- `agents.defaults.memorySearch` indexes memory files and sessions through the ClawRouters embeddings endpoint. The index and source files stay on the instance volume.
- `tools.web.search` selects the image-bundled `oneclaw-search` provider. Search calls use the same user child key and go to ClawRouters `/api/v1/search`; SearXNG/Tavily credentials, caching, fallback, and Credits billing remain server-side.
- `talk.realtime` selects OpenClaw's native OpenAI-compatible Gateway relay and points it at ClawRouters `/api/v1/realtime`. The Control UI captures and plays audio, while provider credentials, model routing, metering, VAD, and Agent consultation remain Gateway/ClawRouters-owned.
- `messages.tts` prepares the standard `tts.speak` path through ClawRouters `/api/v1/audio/speech` for read-aloud and turn-based fallback flows. Automatic playback remains disabled.
- An explicitly selected third-party search provider or `enabled=false` setting is preserved.
- Explicit user-owned Talk and TTS providers are preserved. If the ClawRouters key is removed, only the OneClaw-managed voice entries are removed from the persisted config.

Realtime Talk already includes live input transcription and synthesized output.
Reviewed composer dictation is separate: ClawRouters currently exposes batch
`/audio/transcriptions`, while the pinned Control UI expects a streaming
transcription provider, so managed cloud dictation is not enabled by this
runtime default.

### Native orchestration and structured input

Employees and teams use OpenClaw's native Agent Sessions, `sessions_spawn`,
`sessions_yield`, child-session history, Background Tasks, Workboard, and the
structured `update_plan` tool. The retired `oneclaw-workflows` and
`oneclaw-employee-catalog` plugins are removed from persisted configuration at
startup and are not installed in the image. Structured input and external-app
authorization are published directly as OneClaw Channel Attention events.
Clients answer with Channel control commands, so there is no secondary
interaction service or repair endpoint.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `SETUP_PASSWORD` | Protects the `/login` page. If unset, login is open with no password. |

At least one model provider key is required to trigger auto-configuration:

| Variable | Description |
|----------|-------------|
| `CLAWROUTERS_API_KEY` | ClawRouters multi-model router (recommended) |
| `ANTHROPIC_API_KEY` | Anthropic Claude direct |
| `OPENAI_API_KEY` | OpenAI direct |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini direct |
| `DEEPSEEK_API_KEY` | DeepSeek direct |
| `OPENROUTER_API_KEY` | OpenRouter |

Direct OpenAI providers default to OpenClaw's embedded agent runtime, matching
OneClaw Desktop. An explicit `agentRuntime` selection is preserved; otherwise
this avoids a multi-GB Codex harness download during the first cloud boot.

### Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Wrapper HTTP port |
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | Config and credentials directory |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Agent workspace directory |

### Channels

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `DISCORD_BOT_TOKEN` | Discord bot token (requires MESSAGE CONTENT INTENT in Dev Portal) |
| `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Slack bot and app tokens |
| `FEISHU_APP_ID` + `FEISHU_APP_SECRET` | Feishu/Lark app credentials |
| `WHATSAPP_ENABLED=1` | Enable WhatsApp channel; QR binding done at runtime via oneclaw_web panel |
| `WECHAT_ENABLED=1` | Enable WeChat channel; QR binding done at runtime via oneclaw_web panel |

### OneClaw Platform Integration

| Variable | Description |
|----------|-------------|
| `ONECLAW_API_URL` | OneClaw API endpoint (default: `https://www.oneclaw.net/api/v1`) |
| `ONECLAW_INSTANCE_ID` | Instance ID assigned by oneclaw_web |
| `ONECLAW_INSTANCE_SECRET` | Instance secret for heartbeat auth and protected platform-to-runtime repair calls |
| `ONECLAW_RUNTIME_CONTRACT` | Runtime personality contract version (default: `3`) |
| `ONECLAW_USER_AGENT` | Outbound model/embedding/Realtime identity (default: `OneClaw-Cloud/<IMAGE_VERSION>`; explicit Provider headers win) |

The wrapper also consumes OneClaw's authenticated Runtime MCP snapshot. Startup reconciliation and the existing `sync_mcp` Runtime Command update only `mcp.servers.oneclaw-composio-main`, preserve user-managed MCP servers, and rely on OpenClaw's native `mcp.*` hot reload without restarting the Gateway. OpenClaw connects to a loopback-only Sidecar MCP endpoint protected by a local-scoped token stored with mode `0600`; the Sidecar authenticates to the OneClaw API with the in-memory Runtime secret, and the API injects the platform Composio key upstream. Neither long-lived credential is stored in `openclaw.json`, Runtime Commands, or heartbeat data.

### Optional / Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | auto-generated | Gateway bearer token (persisted to `STATE_DIR/gateway.token` if not set) |
| `INTERNAL_GATEWAY_PORT` | `18789` | Gateway internal port |
| `OPENCLAW_ENTRY` | `/usr/local/lib/node_modules/openclaw/dist/entry.js` | Path to openclaw `entry.js` |
| `ONECLAW_FAST_GATEWAY_ENTRY` | image default | Version-validated fast Gateway launcher; set empty to use the standard OpenClaw CLI |
| `PROXY_TIMEOUT_MS` | `600000` | Reverse proxy timeout |
| `GATEWAY_CHAT_COMPLETIONS_ENABLED` | off | Enable `POST /v1/chat/completions` (also enables `/v1/models` and `/v1/embeddings`) |
| `GATEWAY_RESPONSES_ENABLED` | off | Enable `POST /v1/responses` |
| `ONECLAW_PREINSTALLED_SKILLS_ENABLED` | on | Set to `false` to disable image-bundled common skills |

`ONECLAW_RUNTIME_PROFILE` is an image build argument, not a Railway runtime variable.

GitHub Actions builds `standard` first and then `full`, importing the standard
cache into the additive full build. A push to `main` publishes `latest`,
`standard`, and `full`. A `v*` tag additionally publishes the immutable semver,
`<version>-standard`, and `<version>-full` tags. Manual runs default to both but
can build only one profile while diagnosing a profile-specific failure.

## Local Docker Run

```bash
# Standard common/document runtime
docker build -t openclaw-railway-template:standard .

# Optional complete local-tool image
docker build --build-arg ONECLAW_RUNTIME_PROFILE=full -t openclaw-railway-template:full .

# Run
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e CLAWROUTERS_API_KEY=your_key_here \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# Access
# Health check:  http://localhost:8080/health
# Login page:    http://localhost:8080/login   (password: test)
# Control UI:    http://localhost:8080/openclaw
```

Add channel tokens as additional `-e` flags:

```bash
  -e TELEGRAM_BOT_TOKEN=123456789:AA... \
  -e DISCORD_BOT_TOKEN=your_discord_token \
```

## Railway Deployment

1. Let CI publish both profiles to a registry using immutable `<version>-standard` and `<version>-full` tags.
2. Configure OneClaw API's `openclaw_standard_image` and `openclaw_full_image`; Railway receives the selected image during provision/redeploy.
3. Mount a **Volume** at `/data` and set the runtime variables.
4. Enable **public networking** and deploy.

The image already contains OpenClaw, the wrapper, channel plugins, and the
selected skills. Startup performs no npm/pip installs, Go builds, or large
directory copies. Normal configuration delivered through OneClaw/OpenClaw is
hot-reloaded. Changing Railway Variables itself still creates a new Railway
deployment; changing Agents, model keys, or channels through the runtime does not.

Phase-level OpenClaw startup tracing is enabled by default. The wrapper's
`[boot]` lines plus OpenClaw's `startup trace:` lines separate HTTP wrapper,
profile preload, internal Gateway phases, Gateway readiness, and platform
reconciliation timings. The pinned image validates a dedicated Gateway entry
at build time and skips OpenClaw's duplicate generic CLI/Doctor bootstrap at
runtime. If the OpenClaw version or internal export contract changes, the
launcher automatically falls back to the public CLI.

Checklist:
- Volume mounted at `/data`
- `SETUP_PASSWORD` set (or intentionally left blank for open access)
- At least one provider API key set
- Public networking enabled

## Directory Structure

```
src/
├── index.js               # PID1 entry: writes openclaw.json, spawns gateway, starts Express
├── config/                # Config generation from env (generate.js, runtime-defaults.js, plugins.js, edit.js)
│   └── direct-config.js   # Core config builder: buildHttpEndpoints(), applyRuntimeDefaults()
├── gateway/               # Gateway process management (manager.js, gateway-rpc.js)
├── channels/              # Channel config writers (Telegram/Discord/Slack/Feishu/WhatsApp/WeChat)
├── integration/           # OneClaw platform integration (heartbeat, personality sync)
├── proxy/                 # Reverse proxy and auth (proxy.js, auth.js)
├── repair/                # Repair assistant routes (assistant.js, config-ops.js, qr-login.js)
├── skills/                # AI tool definitions for repair assistant
└── public/                # Static pages: login.html, loading.html
start.sh                   # Docker entrypoint: fix /data permissions → gosu → node src/index.js
Dockerfile                 # Standard/full layered profiles; immutable plugins and skills under /opt
railway.toml               # Railway deployment config
docker-compose.yml         # Local development compose
```

## Channels

### Telegram

1. Message **@BotFather** in Telegram.
2. Run `/newbot` and follow the prompts.
3. Copy the token (format: `123456789:AA...`).
4. Set `TELEGRAM_BOT_TOKEN` in your Railway Variables and redeploy.

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers/applications).
2. **New Application** → **Bot** tab → **Add Bot** → copy the token.
3. Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents.
4. Invite the bot via OAuth2 URL Generator (scopes: `bot`, `applications.commands`).
5. Set `DISCORD_BOT_TOKEN` in Railway Variables and redeploy.

### Feishu / Lark

Set `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in Railway Variables.

### WhatsApp

Set `WHATSAPP_ENABLED=1`. After deployment, use the oneclaw_web panel to complete QR binding.

### WeChat

Set `WECHAT_ENABLED=1`. After deployment, use the oneclaw_web panel to complete QR binding.

## FAQ

**Q: How do I access the Control UI?**

A: Visit `/login` on your deployed instance, enter your `SETUP_PASSWORD`, then navigate to `/openclaw`. The wrapper automatically injects the gateway bearer token so you do not need to configure authentication manually.

**Q: I see "gateway disconnected" or authentication errors in the Control UI.**

A: Visit `/login` first to obtain a session, then navigate to `/openclaw`. If the issue persists, check container logs for gateway startup errors and verify `OPENCLAW_STATE_DIR` is writable (volume mounted correctly).

**Q: How do I diagnose or repair problems?**

A: The repair assistant is available via the oneclaw_web panel, which calls `/repair/*` endpoints. It provides AI-assisted diagnostics, gateway restart, and QR binding for WhatsApp/WeChat.

**Q: How do I change the AI model?**

A: Set a different provider API key or use `CLAWROUTERS_API_KEY` for multi-model routing. Model selection can also be configured through the Control UI at `/openclaw` after login.

**Q: How does the gateway bearer token work across redeploys?**

A: If `OPENCLAW_GATEWAY_TOKEN` is not set, the wrapper auto-generates a token on first startup and persists it to `${OPENCLAW_STATE_DIR}/gateway.token`. As long as the `/data` volume is mounted, the same token is reused across redeploys.

For platform dashboards, do not expose `OPENCLAW_GATEWAY_TOKEN` to browsers. Use `POST /repair/openclaw-login` with `Authorization: Bearer <ONECLAW_INSTANCE_SECRET>` to issue a short-lived `/oneclaw-login?ticket=...` URL. The browser consumes that URL to receive an HttpOnly session cookie before entering `/openclaw/` or `/openclaw/chat`.

**Q: Why are plugins baked into the image rather than installed at runtime?**

A: OpenClaw's plugin discovery does not scan global `node_modules`. Plugins are installed into `/opt/openclaw-plugins` during the Docker build and normally declared via `plugins.load.paths` in `openclaw.json`. Before Gateway launch, the wrapper also registers those immutable packages in OpenClaw's canonical `state/openclaw.sqlite` installed-plugin index; this prevents startup Doctor from downloading configured channels into `/data`. Once that index is durable, stale `/data` extension copies and matching managed npm projects are removed. The Gateway-privileged `oneclaw-channel` package is copied from the same exact npm lock into OpenClaw's immutable bundled extension tree instead, then its ordinary `/opt` copy is removed so a persisted install index cannot shadow the trusted version. Channel explicitly links the global OpenClaw host and the locked Runtime Events SDK (plus its `ajv` and `ws` runtime dependencies) from its bundled directory. This avoids a large runtime `cp` or npm install on every boot, preserves OpenClaw's plugin trust checks, and ensures the `/data` volume mount does not shadow plugin files.

## Support

Need help? [Request support on Railway Station](https://station.railway.com/all-templates/d0880c01-2cc5-462c-8b76-d84c1a203348)
