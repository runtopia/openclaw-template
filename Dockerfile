FROM node:22-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    procps \
    python3 \
    build-essential \
    # Browser dependencies for Chrome/Chromium web browsing capability
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libdrm2 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libgbm1 \
    libxss1 \
    libasound2 \
    libgtk-3-0 \
    libxshmfence1 \
    libgconf-2-4 \
    libxtst6 \
    libatspi2.0-0 \
    libxkbcommon0 \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

# Pin OpenClaw core.
ARG OPENCLAW_VERSION=2026.5.12
RUN npm install -g openclaw@${OPENCLAW_VERSION}

# Pre-install channel plugins at build time using the same mechanism as
# start.sh, so the container boot skips straight past plugin installation.
# The plugin npm store is placed under /usr/local/lib/openclaw-plugins/;
# start.sh is patched below to check there first.
# --pin records the resolved <name>@<version>, locking the plugin to the build-
# time openclaw core. Each install is followed by a hard check that the plugin
# package landed on disk — silent install failures here are the worst-case
# (runtime then tries to install the missing plugin and trips the managed-npm
# peer-scan against stale state).
ARG CACHEBUST_PLUGINS=v5
RUN mkdir -p /usr/local/lib/openclaw-plugins/npm && \
  for pkg in \
    @openclaw/codex \
    @openclaw/discord \
    @openclaw/whatsapp \
    @larksuite/openclaw-lark \
    @tencent-weixin/openclaw-weixin; do \
    echo "[prebuilt] installing ${pkg}@${OPENCLAW_VERSION}"; \
    OPENCLAW_STATE_DIR=/usr/local/lib/openclaw-plugins openclaw plugins install "${pkg}@${OPENCLAW_VERSION}" --pin || { echo "FATAL: ${pkg} install command failed"; exit 1; }; \
    test -f "/usr/local/lib/openclaw-plugins/npm/node_modules/${pkg}/package.json" || { echo "FATAL: ${pkg} not present after install"; ls /usr/local/lib/openclaw-plugins/npm/node_modules/ 2>/dev/null; exit 1; }; \
  done && \
  echo "[prebuilt] final npm/package.json:" && \
  cat /usr/local/lib/openclaw-plugins/npm/package.json && \
  # Make pre-built plugins readable by the non-root 'openclaw' user
  chmod -R a+rX /usr/local/lib/openclaw-plugins

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN corepack enable && pnpm install --frozen-lockfile --prod

# Cache buster - change this to force rebuild
ARG CACHEBUST=v20260212-chromium

COPY src ./src
COPY start.sh ./start.sh

RUN useradd -m -s /bin/bash openclaw \
  && chown -R openclaw:openclaw /app \
  && mkdir -p /data && chown openclaw:openclaw /data \
  && chmod +x /app/start.sh

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD curl -f http://localhost:8080/setup/healthz || exit 1

USER openclaw
CMD ["/bin/bash", "/app/start.sh"]
