#!/bin/bash
# OneClaw startup script.
#
# Runs as root so it can fix /data ownership after Railway mounts the volume
# (Railway volumes are mounted root:root regardless of image layer permissions).
# After fixing permissions it drops to the non-root `openclaw` user via gosu.
#
# On non-Docker dev boxes (already running as openclaw / non-root), the gosu
# path is skipped and the process starts directly.
set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"

# Normalize legacy CLAWROUTERS_KEY to CLAWROUTERS_API_KEY so the plugin's
# SecretRef config (id: "CLAWROUTERS_API_KEY") always resolves correctly.
if [ -z "$CLAWROUTERS_API_KEY" ] && [ -n "$CLAWROUTERS_KEY" ]; then
  export CLAWROUTERS_API_KEY="$CLAWROUTERS_KEY"
fi

if [ "$(id -u)" = "0" ]; then
  # Fix /data ownership — volume was mounted root:root by Railway.
  chown -R openclaw:openclaw /data
  mkdir -p "$STATE_DIR" "$WORKSPACE_DIR"
  chown -R openclaw:openclaw "$STATE_DIR" "$WORKSPACE_DIR"
  exec gosu openclaw node src/server.js
fi

# Non-root fallback (local dev without Docker).
mkdir -p "$STATE_DIR" "$WORKSPACE_DIR"
exec node src/server.js
