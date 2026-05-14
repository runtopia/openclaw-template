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

# Pin OpenClaw core. Channel plugins are installed at runtime via
# `openclaw plugins install` so they land in $OPENCLAW_STATE_DIR/npm
# (which lives on the persisted Railway volume). See start.sh.
ARG OPENCLAW_VERSION=2026.5.7
RUN npm install -g openclaw@${OPENCLAW_VERSION}

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
