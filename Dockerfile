FROM node:22-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gosu \
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
ARG OPENCLAW_VERSION=2026.6.10
RUN npm install -g openclaw@${OPENCLAW_VERSION}

# Pre-install plugins OUTSIDE the /data volume, into a fixed image path.
# WHY here and not via `openclaw plugins install`:
#   OpenClaw's managed install writes into $STATE_DIR/npm/node_modules, and
#   STATE_DIR lives on the Railway volume. The volume mount shadows whatever
#   the image baked in, so a managed prebuilt would have to be cp'd to the
#   volume on every boot (~650MB → ~70s). See git 2740039 for why that was
#   dropped.
#   Instead we install into /opt (never on the volume) and point OpenClaw at
#   it via `plugins.load.paths`. The discovery code (discoverFromPath) accepts
#   any path and resolves each plugin's deps through the adjacent node_modules,
#   so this needs zero runtime copy and zero runtime npm install.
#   Channels (verified against openclaw 2026.6.10 source):
#     - telegram is BUILT INTO openclaw core (dist/extensions/telegram) — no
#       plugin to install here.
#     - slack / discord / feishu / whatsapp are official standalone packages.
#     - wechat has no official package; @tencent-weixin/openclaw-weixin is the
#       third-party plugin (channel id "openclaw-weixin", versioned separately).
#   Plus clawrouters (chat/image/video providers; GitHub-only, not on npm).
#
# CACHEBUST_PLUGINS: increment to force-reinstall all plugins (e.g. after
# pinning a new version or when the layer is stale from a prior @latest build).
ARG CACHEBUST_PLUGINS=v4
ENV OPENCLAW_PLUGINS_DIR=/opt/openclaw-plugins
RUN mkdir -p ${OPENCLAW_PLUGINS_DIR} \
  && cd ${OPENCLAW_PLUGINS_DIR} \
  && npm init -y >/dev/null 2>&1 \
  && npm install --omit=dev --no-audit --no-fund \
       github:runtopia/clawrouters-plugin \
       @openclaw/slack@2026.6.10 \
       @openclaw/discord@2026.6.10 \
       @openclaw/feishu@2026.6.10 \
       @openclaw/whatsapp@2026.6.10 \
       @tencent-weixin/openclaw-weixin@2.4.6 \
  && node -e "const fs=require('fs'); const root=process.env.OPENCLAW_PLUGINS_DIR + '/node_modules/@tencent-weixin/openclaw-weixin'; const files=['dist/src/messaging/process-message.js','src/messaging/process-message.ts']; for (const rel of files) { const p=root + '/' + rel; let s=fs.readFileSync(p,'utf8'); const before='list.length === 0 || list.includes(id)'; if (!s.includes(before)) throw new Error('weixin pairing patch target not found: ' + rel); s=s.replaceAll(before, 'list.includes(id)'); fs.writeFileSync(p,s); }" \
  && chmod -R a+rX ${OPENCLAW_PLUGINS_DIR}

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
  && mkdir -p /data \
  && chmod +x /app/start.sh

# Image version — pass at build time: docker build --build-arg IMAGE_VERSION=1.2.3
ARG IMAGE_VERSION=dev
ENV IMAGE_VERSION=${IMAGE_VERSION}
LABEL org.opencontainers.image.version=${IMAGE_VERSION}

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
EXPOSE 8080

# /health 是 openclaw gateway 自带的无认证端点
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -f http://localhost:${PORT}/health || exit 1

# CMD runs as root so start.sh can fix /data ownership on Railway volume mounts,
# then drops to the non-root openclaw user via gosu.
CMD ["/bin/bash", "/app/start.sh"]
