# OpenClaw Railway Template

Deploy **OpenClaw** (an AI coding assistant platform) on Railway as a single container. Configuration is fully env-driven — no setup wizard, no web terminal. The [oneclaw_web](https://www.oneclaw.net) SaaS console manages deployment and onboarding per user.

## What you get

- **OpenClaw Gateway + Control UI** at `/openclaw`
- **Reverse proxy** on `PORT` with automatic Bearer token injection
- **Persistent state** via Railway Volume (`/data`) — config, credentials, and memory survive redeploys
- **Repair console** at `/repair/*` — AI diagnostic chat, gateway restart, QR binding for WhatsApp/WeChat
- **Health endpoint** at `/health`
- **Login page** at `/login` (protected by `SETUP_PASSWORD`)

## Architecture

```
User Request
  ↓
Wrapper (Express on PORT)
  ├─ /health         → liveness probe
  ├─ /login          → Control UI login page (auth: SETUP_PASSWORD)
  ├─ /repair/*       → repair assistant (auth: session or Bearer secret)
  └─ all other       → reverse-proxied to openclaw gateway (Bearer token auto-injected)
```

### Lifecycle

1. **Startup**: wrapper reads env vars → writes `openclaw.json` (idempotent) → spawns `openclaw gateway` → waits for gateway readiness → begins serving traffic.
2. **Runtime**: auto-heals gateway crashes (exponential backoff, max 5 restarts). Sends heartbeat/stats/personality to oneclaw_web when platform env vars are set.
3. **Repair**: `/repair/*` endpoints let oneclaw_web's panel (or direct API calls) run AI diagnostics, restart the gateway, or trigger QR binding flows for WhatsApp/WeChat.

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
| `ONECLAW_INSTANCE_SECRET` | Instance secret for heartbeat auth |
| `ONECLAW_TEMPLATE_ID` | Template ID (optional) |

### Optional / Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY_TOKEN` | auto-generated | Gateway bearer token (persisted to `STATE_DIR/gateway.token` if not set) |
| `INTERNAL_GATEWAY_PORT` | `18789` | Gateway internal port |
| `OPENCLAW_ENTRY` | `/usr/local/lib/node_modules/openclaw/dist/entry.js` | Path to openclaw `entry.js` |
| `PROXY_TIMEOUT_MS` | `600000` | Reverse proxy timeout |
| `GATEWAY_CHAT_COMPLETIONS_ENABLED` | off | Enable `POST /v1/chat/completions` (also enables `/v1/models` and `/v1/embeddings`) |
| `GATEWAY_RESPONSES_ENABLED` | off | Enable `POST /v1/responses` |

## Local Docker Run

```bash
# Build
docker build -t openclaw-railway-template .

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

1. Fork or use this template in Railway.
2. Mount a **Volume** at `/data`.
3. Set **environment variables** in Railway Variables (see above).
4. Enable **public networking** (assigns `*.up.railway.app` domain).
5. Deploy — the container auto-configures on startup.

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
Dockerfile                 # Single-stage build: installs OpenClaw core + plugins into /opt/openclaw-plugins
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

A: OpenClaw's plugin discovery does not scan global `node_modules`. Plugins are installed into `/opt/openclaw-plugins` during the Docker build and declared via `plugins.load.paths` in `openclaw.json`. This avoids a large runtime `cp` on every boot and ensures the `/data` volume mount does not shadow plugin files.

## Support

Need help? [Request support on Railway Station](https://station.railway.com/all-templates/d0880c01-2cc5-462c-8b76-d84c1a203348)
