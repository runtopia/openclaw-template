#!/bin/bash
# OneClaw startup script
# 1. Pre-install channel plugins into $OPENCLAW_STATE_DIR (idempotent)
# 2. Waits for config file and runs doctor --fix in background
# NOTE: Skip doctor --fix when auto-config env vars are present,
# because server.js auto-config handles doctor --fix itself.
# Running both concurrently causes a race condition where
# concurrent writes to openclaw.json corrupt the config.

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_FILE="$STATE_DIR/openclaw.json"
OPENCLAW_CMD="node /usr/local/lib/node_modules/openclaw/dist/entry.js"

# Plugins are pre-installed at Docker build time into /usr/local/lib/openclaw-plugins/.
# At boot we just copy them over — no npm link, no config writes, no network.
# If the pre-built directory is missing (e.g. non-Docker dev), we fall through
# to the legacy install path.
PLUGINS_TO_INSTALL=(
  "@openclaw/codex"
  "@openclaw/discord"
  "@openclaw/whatsapp"
  "@larksuite/openclaw-lark"
  "@tencent-weixin/openclaw-weixin"
)

PREBUILT_PLUGIN_DIR="/usr/local/lib/openclaw-plugins"

install_channel_plugins() {
  mkdir -p "$STATE_DIR/npm/node_modules"
  local npm_root="$STATE_DIR/npm/node_modules"

  # Fast path: copy from pre-built image layer. We tried symlinks but openclaw's
  # plugin discovery doesn't follow them — it resolves real paths and filters out
  # anything outside STATE_DIR/npm/node_modules. cp is the only reliable approach.
  #
  # Wipe STATE_DIR/npm/node_modules entirely before cp:
  #   - Railway volume can carry stale state from older deployments (e.g.
  #     @anthropic-ai/sdk left over from when codex was installed at runtime,
  #     possibly as an absolute symlink into /usr/local/...).
  #   - OpenClaw's managed-npm peer scan (npm-managed-root) does fs.realpath
  #     on every node_modules entry and throws if it resolves outside the npm
  #     root boundary — stale absolute symlinks blow up plugin install.
  # Also wipe package.json / package-lock.json so they're replaced by prebuilt
  # versions (not merged with old).
  if [ -d "$PREBUILT_PLUGIN_DIR/npm/node_modules" ]; then
    echo "[start.sh] copying pre-built plugins from $PREBUILT_PLUGIN_DIR…"
    rm -rf "$npm_root" "$STATE_DIR/npm/package.json" "$STATE_DIR/npm/package-lock.json"
    mkdir -p "$npm_root"
    cp -r "$PREBUILT_PLUGIN_DIR/npm/." "$STATE_DIR/npm/"
    for pkg in "${PLUGINS_TO_INSTALL[@]}"; do
      if [ -f "$STATE_DIR/npm/node_modules/$pkg/package.json" ]; then
        echo "[start.sh] plugin ready: $pkg"
      else
        echo "[start.sh] WARN: $pkg missing in prebuilt (expected at $STATE_DIR/npm/node_modules/$pkg)"
      fi
    done
    return
  fi

  # Fallback: install at runtime (local dev without Docker)
  echo "[start.sh] pre-built plugins not found, installing at runtime…"
  for pkg in "${PLUGINS_TO_INSTALL[@]}"; do
    if [ -d "$npm_root/$pkg" ]; then
      echo "[start.sh] plugin already present: $pkg"
      continue
    fi
    echo "[start.sh] installing plugin: $pkg"
    if ! OPENCLAW_STATE_DIR="$STATE_DIR" $OPENCLAW_CMD plugins install "$pkg" --pin; then
      echo "[start.sh] plugin install failed (continuing): $pkg"
    fi
  done
}

echo "[start.sh] Setting up channel plugins…"
install_channel_plugins

# Returns 0 only when openclaw.json shows a completed onboard.
# `gateway.mode` is the right signal because:
#  - onboard always writes it ("local" via --gateway-bind loopback)
#  - `openclaw plugins install` (run above) creates a minimal config WITHOUT it
#  - `doctor --fix` does NOT auto-set it (it bails with "missing gateway.mode")
# So checking for it cleanly distinguishes "user finished setup" from
# "wrapper just pre-installed plugins".
is_onboarded() {
  [ -f "$CONFIG_FILE" ] || return 1
  node -e '
    try {
      const cfg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      process.exit(cfg && cfg.gateway && cfg.gateway.mode ? 0 : 1);
    } catch { process.exit(1); }
  ' "$CONFIG_FILE" 2>/dev/null
}

# Configure browser automation: use openclaw's managed browser profile
# This avoids Chrome Relay dependency and provides a fully controlled headless browser
configure_browser() {
  echo "[start.sh] Configuring browser: defaultProfile=openclaw"
  $OPENCLAW_CMD config set browser.defaultProfile openclaw 2>/dev/null || true
}

# Check if auto-config will handle doctor --fix
# Auto-config runs when ANY AI API key env var is set
HAS_AUTO_CONFIG_KEYS=false
if [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$OPENAI_API_KEY" ] || [ -n "$GOOGLE_GENERATIVE_AI_API_KEY" ] || [ -n "$DEEPSEEK_API_KEY" ] || [ -n "$OPENROUTER_API_KEY" ] || [ -n "$CLAWROUTERS_KEY" ]; then
  HAS_AUTO_CONFIG_KEYS=true
fi

# The setup wizard (POST /setup/api/run) handles doctor --fix internally and
# restarts the gateway. We skip it here to avoid race conditions.
# For auto-config mode (AI API keys set via env), server.js also handles it.

# Start the main server (foreground)
echo "[start.sh] Starting server..."
exec node src/server.js
