FROM golang:1.26.5-bookworm AS builtin-skill-go-tools

# Go-based dependencies declared by OpenClaw's bundled skills. Keep these in a
# builder stage so the runtime image only receives the resulting executables.
RUN mkdir -p /out \
  && GOBIN=/out go install github.com/Hyaxia/blogwatcher/cmd/blogwatcher@v0.0.3 \
  && GOBIN=/out go install github.com/steipete/blucli/cmd/blu@v0.1.5 \
  && GOBIN=/out go install github.com/steipete/eightctl/cmd/eightctl@v0.0.0-20260713021800-e05b8da853b9 \
  && GOBIN=/out go install github.com/steipete/gifgrep/cmd/gifgrep@v0.3.0 \
  && GOBIN=/out go install github.com/steipete/ordercli/cmd/ordercli@v0.1.0 \
  && GOBIN=/out go install github.com/steipete/sonoscli/cmd/sonos@v0.3.3 \
  && GOBIN=/out go install github.com/steipete/gogcli/cmd/gog@v0.9.0 \
  && GOBIN=/out go install github.com/openclaw/wacli/cmd/wacli@v0.12.0

FROM debian:bookworm-slim AS builtin-skill-himalaya

ARG TARGETARCH
ARG HIMALAYA_VERSION=1.2.0
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl \
  && case "${TARGETARCH}" in \
       amd64) archive_arch=x86_64; archive_sha=e04e6382e3e664ef34b01afa1a2216113194a2975d2859727647b22d9b36d4e4 ;; \
       arm64) archive_arch=aarch64; archive_sha=643020b220991fac67726f3be11310fcf806e757feadbbab3efbddd713597872 ;; \
       *) echo "unsupported Himalaya target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/himalaya.tgz \
       "https://github.com/pimalaya/himalaya/releases/download/v${HIMALAYA_VERSION}/himalaya.${archive_arch}-linux.tgz" \
  && echo "${archive_sha}  /tmp/himalaya.tgz" | sha256sum -c - \
  && mkdir -p /out \
  && tar -xzf /tmp/himalaya.tgz -C /out himalaya

FROM node:24-bookworm

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    ffmpeg \
    gh \
    git \
    gosu \
    jq \
    procps \
    poppler-utils \
    python3 \
    python3-venv \
    ripgrep \
    tesseract-ocr \
    tmux \
    unzip \
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
# 固定在 2026.6.10：2026.6.11 的 reply session 初始化改用整-entry CAS（只重试一次），
# 会导致 dashboard/webchat 二轮对话及微信等通道第二条消息起报
# "reply session initialization conflicted"。6.10 无此逻辑。
ARG OPENCLAW_VERSION=2026.6.10
ENV OPENCLAW_VERSION=${OPENCLAW_VERSION}
ARG CLAWHUB_VERSION=0.23.1
ARG CODEX_VERSION=0.144.4
ARG GEMINI_CLI_VERSION=0.50.0
ARG MCPORTER_VERSION=0.12.3
ARG ORACLE_VERSION=0.16.0
ARG XURL_VERSION=1.2.2
ARG SUMMARIZE_VERSION=0.11.1
RUN npm install -g \
      openclaw@${OPENCLAW_VERSION} \
      clawhub@${CLAWHUB_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      @google/gemini-cli@${GEMINI_CLI_VERSION} \
      mcporter@${MCPORTER_VERSION} \
      @steipete/oracle@${ORACLE_VERSION} \
      @steipete/summarize@${SUMMARIZE_VERSION} \
      @xdevplatform/xurl@${XURL_VERSION}

COPY --from=builtin-skill-go-tools /out/ /usr/local/bin/
COPY --from=builtin-skill-himalaya /out/himalaya /usr/local/bin/himalaya

RUN python3 -m venv /opt/oneclaw-python \
  && /opt/oneclaw-python/bin/pip install --no-cache-dir nano-pdf==0.2.1
ENV PATH="/opt/oneclaw-python/bin:${PATH}"

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
ARG CACHEBUST_PLUGINS=v7
ENV OPENCLAW_PLUGINS_DIR=/opt/openclaw-plugins
WORKDIR /app
COPY scripts ./scripts
# 2026.6.10 会保存 chat.send 图片，却未把保存路径交给当前 agent；构建时补齐并在上游修复后移除。
RUN node /app/scripts/patch-openclaw-chat-images.js /usr/local/lib/node_modules/openclaw
RUN mkdir -p ${OPENCLAW_PLUGINS_DIR} \
  && cd ${OPENCLAW_PLUGINS_DIR} \
  && npm init -y >/dev/null 2>&1 \
  && npm install --omit=dev --no-audit --no-fund \
       github:runtopia/clawrouters-plugin#0.4.1 \
       @openclaw/slack@2026.6.10 \
       @openclaw/discord@2026.6.10 \
       @openclaw/feishu@2026.6.10 \
       @openclaw/whatsapp@2026.6.10 \
       @tencent-weixin/openclaw-weixin@2.4.6 \
  && node /app/scripts/patch-weixin-http-routes.js ${OPENCLAW_PLUGINS_DIR}/node_modules/@tencent-weixin/openclaw-weixin \
  && node /app/scripts/patch-weixin-access-policy.js ${OPENCLAW_PLUGINS_DIR}/node_modules/@tencent-weixin/openclaw-weixin \
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
  && chmod +x /app/start.sh /app/scripts/verify-linux-template-skills.sh

# Image version — pass at build time: docker build --build-arg IMAGE_VERSION=1.2.3
ARG IMAGE_VERSION=dev
ENV IMAGE_VERSION=${IMAGE_VERSION}
ENV ONECLAW_RUNTIME_CONTRACT=1
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
