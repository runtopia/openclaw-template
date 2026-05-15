#!/bin/bash
# OneClaw startup script.
# No plugin prebuilt step — OpenClaw's missing-configured-plugin-install flow
# lazy-installs channel plugins on first gateway start whenever the user
# enables a channel that isn't already on disk. Container boot stays in the
# seconds-range.
set -e

mkdir -p "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
mkdir -p "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"

exec node src/server.js
