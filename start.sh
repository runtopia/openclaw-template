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
  "@openclaw/discord"
  "@openclaw/whatsapp"
  "@larksuite/openclaw-lark"
  "@tencent-weixin/openclaw-weixin"
)

PREBUILT_PLUGIN_DIR="/usr/local/lib/openclaw-plugins"

install_channel_plugins() {
  mkdir -p "$STATE_DIR/npm/node_modules"
  local npm_root="$STATE_DIR/npm/node_modules"

  # Fast path: copy from pre-built image layer
  if [ -d "$PREBUILT_PLUGIN_DIR/npm/node_modules" ]; then
    echo "[start.sh] copying pre-built plugins from $PREBUILT_PLUGIN_DIR…"
    cp -r "$PREBUILT_PLUGIN_DIR/npm/." "$STATE_DIR/npm/"
    # Ensure config JSON references plugins
    for pkg in "${PLUGINS_TO_INSTALL[@]}"; do
      echo "[start.sh] plugin ready: $pkg"
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

# Background task: wait until user finishes onboard, then run doctor --fix.
# Only relevant for instances that go through the setup wizard (no auto-config
# env vars). pre-onboard the config file already exists (we created it during
# plugin install), so we must wait for the *onboard* signal, not just file
# existence — otherwise doctor --fix runs on an empty config and corrupts it.
if [ "$HAS_AUTO_CONFIG_KEYS" = "false" ]; then
  (
    echo "[start.sh] Waiting for user onboard (gateway.mode set)..."

    # Wait up to 30 minutes for user to complete the setup wizard.
    for i in {1..1800}; do
      if is_onboarded; then
        echo "[start.sh] Onboard detected, waiting 5s for completion..."
        sleep 5

        echo "[start.sh] Running openclaw doctor --fix..."
        $OPENCLAW_CMD doctor --fix
        echo "[start.sh] doctor --fix completed with exit code: $?"

        configure_browser
        break
      fi
      sleep 1
    done
  ) &
else
  echo "[start.sh] Auto-config env vars detected, skipping background doctor --fix (server.js handles it)"
  # Configure browser after a delay to let auto-config create the config file first
  (
    sleep 15
    configure_browser
  ) &
fi

# Start the main server (foreground)
echo "[start.sh] Starting server..."
exec node src/server.js
