ARG OP_VERSION=2.35.0

FROM golang:1.26.5-bookworm AS builtin-skill-go-tools

ARG GO_PROXY=https://goproxy.cn,direct

# Go-based dependencies declared by OpenClaw's bundled skills. Keep these in a
# builder stage so the runtime image only receives the resulting executables.
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked \
    --mount=type=cache,target=/root/.cache/go-build,sharing=locked \
  set -eu; \
  mkdir -p /out; \
  install_go_tool() { \
    package="$1"; \
    attempt=1; \
    while ! GOPROXY="${GO_PROXY}" GOBIN=/out go install "${package}"; do \
      if [ "${attempt}" -ge 3 ]; then \
        echo "go install ${package} failed after ${attempt} attempts" >&2; \
        return 1; \
      fi; \
      delay=$((attempt * 5)); \
      echo "go install ${package} failed; retrying in ${delay}s" >&2; \
      sleep "${delay}"; \
      attempt=$((attempt + 1)); \
    done; \
  }; \
  install_go_tool github.com/Hyaxia/blogwatcher/cmd/blogwatcher@v0.0.3; \
  install_go_tool github.com/steipete/blucli/cmd/blu@v0.1.5; \
  install_go_tool github.com/steipete/eightctl/cmd/eightctl@v0.0.0-20260713021800-e05b8da853b9; \
  install_go_tool github.com/steipete/gifgrep/cmd/gifgrep@v0.3.0; \
  install_go_tool github.com/steipete/ordercli/cmd/ordercli@v0.1.0; \
  install_go_tool github.com/steipete/sonoscli/cmd/sonos@v0.3.3; \
  install_go_tool github.com/steipete/gogcli/cmd/gog@v0.9.0; \
  install_go_tool github.com/openclaw/wacli/cmd/wacli@v0.12.0

# Reuse the runtime base, which already includes curl, tar, and CA certificates.
# This avoids a second apt update/install during every cold build.
FROM node:24.15.0-bookworm AS builtin-skill-himalaya

ARG TARGETARCH
ARG HIMALAYA_VERSION=1.2.0
RUN case "${TARGETARCH}" in \
       amd64) archive_arch=x86_64; archive_sha=e04e6382e3e664ef34b01afa1a2216113194a2975d2859727647b22d9b36d4e4 ;; \
       arm64) archive_arch=aarch64; archive_sha=643020b220991fac67726f3be11310fcf806e757feadbbab3efbddd713597872 ;; \
       *) echo "unsupported Himalaya target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
     esac \
  && curl -fsSL -o /tmp/himalaya.tgz \
       "https://github.com/pimalaya/himalaya/releases/download/v${HIMALAYA_VERSION}/himalaya.${archive_arch}-linux.tgz" \
  && echo "${archive_sha}  /tmp/himalaya.tgz" | sha256sum -c - \
  && mkdir -p /out \
  && tar -xzf /tmp/himalaya.tgz -C /out himalaya

FROM 1password/op:${OP_VERSION} AS builtin-skill-onepassword

# OpenClaw 2026.7.1 requires a Node build with a WAL-reset-safe embedded
# SQLite. Keep the Runtime image on the same version used by Channel CI.
FROM node:24.15.0-bookworm

ARG DEBIAN_MIRROR=https://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=https://mirrors.aliyun.com/debian-security
ARG NPM_REGISTRY=https://registry.npmmirror.com

RUN npm config set registry "${NPM_REGISTRY}"

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  sed -i \
    -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
    -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
    /etc/apt/sources.list.d/debian.sources \
  && rm -f /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
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
    fonts-liberation

# Pin OpenClaw core to the same runtime shipped by OneClaw Desktop. The
# sidecar's runtime patches and first-party plugins are validated against this
# exact host version.
ARG OPENCLAW_VERSION=2026.7.1
ENV OPENCLAW_VERSION=${OPENCLAW_VERSION}
ARG CLAWHUB_VERSION=0.23.1
ARG CODEX_VERSION=0.144.4
ARG GEMINI_CLI_VERSION=0.50.0
ARG MCPORTER_VERSION=0.12.3
ARG ORACLE_VERSION=0.16.0
ARG XURL_VERSION=1.2.2
ARG SUMMARIZE_VERSION=0.11.1
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install -g --prefer-offline --no-audit --no-fund \
      openclaw@${OPENCLAW_VERSION} \
      clawhub@${CLAWHUB_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      @google/gemini-cli@${GEMINI_CLI_VERSION} \
      mcporter@${MCPORTER_VERSION} \
      @steipete/oracle@${ORACLE_VERSION} \
      @steipete/summarize@${SUMMARIZE_VERSION}

# xurl's npm postinstall downloads its platform binary from GitHub with a
# single https.get() call and no retry. Keep it in a separate layer so a
# transient builder DNS failure retries only this small package rather than
# the complete global toolchain.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  set -eu; \
  for attempt in 1 2 3; do \
    if npm install -g --prefer-offline --no-audit --no-fund \
         @xdevplatform/xurl@${XURL_VERSION}; then \
      break; \
    fi; \
    if [ "${attempt}" -eq 3 ]; then \
      echo "xurl install failed after ${attempt} attempts" >&2; \
      exit 1; \
    fi; \
    delay=$((attempt * 5)); \
    echo "xurl install attempt ${attempt} failed; retrying in ${delay}s" >&2; \
    sleep "${delay}"; \
  done

COPY --from=builtin-skill-go-tools /out/ /usr/local/bin/
COPY --from=builtin-skill-himalaya /out/himalaya /usr/local/bin/himalaya
COPY --from=builtin-skill-onepassword /usr/local/bin/op /usr/local/bin/op

ARG UV_VERSION=0.8.14
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
  python3 -m venv /opt/oneclaw-python \
  && /opt/oneclaw-python/bin/pip install --index-url "${PIP_INDEX_URL}" \
       nano-pdf==0.2.1 \
       uv==${UV_VERSION}
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
#   Channels (verified against openclaw 2026.7.1 source):
#     - telegram is BUILT INTO openclaw core (dist/extensions/telegram) — no
#       plugin to install here.
#     - slack / discord / feishu / whatsapp are official standalone packages.
#     - wechat has no official package; @tencent-weixin/openclaw-weixin is the
#       third-party plugin (channel id "openclaw-weixin", versioned separately).
#   ClawRouters and the other first-party OneClaw plugins are exact npm packages
#   published from runtopia/oneclaw-plugins.
#   Exact top-level versions and their complete dependency graph are locked in
#   resources/openclaw-plugin-bundle/package-lock.json.
#
# CACHEBUST_PLUGINS: increment to force-reinstall all plugins (e.g. after
# pinning a new version or when the layer is stale from a prior @latest build).
ARG CACHEBUST_PLUGINS=v10
ENV OPENCLAW_PLUGINS_DIR=/opt/openclaw-plugins
WORKDIR /app
COPY scripts/patch-openclaw-chat-images.js \
     scripts/patch-openclaw-memory-migration.mjs \
     scripts/patch-weixin-http-routes.js \
     scripts/patch-weixin-access-policy.js \
     ./scripts/
# OpenClaw saves chat.send images but does not pass the managed path to the
# current agent; keep the existing fail-closed patch until upstream removes
# the matching bundle anchors.
RUN node /app/scripts/patch-openclaw-chat-images.js /usr/local/lib/node_modules/openclaw
# OpenClaw 2026.7.1 can leave duplicate legacy Memory Core state in place,
# causing its strict startup migration checkpoint to fail on every restart.
RUN node /app/scripts/patch-openclaw-memory-migration.mjs /usr/local/lib/node_modules/openclaw/dist
# The template is a package consumer. Plugin source, manifests, and internal
# dependency declarations stay in their own packages; this lockfile pins the
# exact set consumed by the cloud Runtime image.
ARG ONECLAW_NPM_REGISTRY=https://registry.npmjs.org
COPY resources/openclaw-plugin-bundle /tmp/openclaw-plugin-bundle
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  cd /tmp/openclaw-plugin-bundle \
  && npm ci --registry="${ONECLAW_NPM_REGISTRY}" --omit=dev --legacy-peer-deps --no-audit --no-fund \
  && mkdir -p ${OPENCLAW_PLUGINS_DIR}/node_modules \
  && cp package.json package-lock.json ${OPENCLAW_PLUGINS_DIR}/ \
  && cp -a node_modules/. ${OPENCLAW_PLUGINS_DIR}/node_modules/ \
  # These first-party plugins call privileged Gateway APIs. Copy their exact
  # locked packages into OpenClaw's immutable bundled tree so the host grants
  # native bundled-plugin trust without weakening its trust checks.
  && cp -a "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel" \
       /usr/local/lib/node_modules/openclaw/dist/extensions/oneclaw-channel \
  && cp -a "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/durable-work" \
       /usr/local/lib/node_modules/openclaw/dist/extensions/oneclaw-workflows \
  && cp -a "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/employee-catalog" \
       /usr/local/lib/node_modules/openclaw/dist/extensions/oneclaw-employee-catalog \
  && for plugin in oneclaw-channel oneclaw-workflows oneclaw-employee-catalog; do \
       plugin_dir="/usr/local/lib/node_modules/openclaw/dist/extensions/${plugin}"; \
       mkdir -p "${plugin_dir}/node_modules"; \
       ln -s /usr/local/lib/node_modules/openclaw "${plugin_dir}/node_modules/openclaw"; \
       test -f "${plugin_dir}/openclaw.plugin.json"; \
     done \
  # Channel's runtime dependencies stay in the locked /opt npm project. Link
  # them explicitly because bundled extensions resolve from their own tree.
  && channel_dir=/usr/local/lib/node_modules/openclaw/dist/extensions/oneclaw-channel \
  && mkdir -p "${channel_dir}/node_modules/@oneclaw-plugins" \
  && ln -s "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/runtime-events" \
       "${channel_dir}/node_modules/@oneclaw-plugins/runtime-events" \
  && for dependency in ajv ws; do \
       ln -s "${OPENCLAW_PLUGINS_DIR}/node_modules/${dependency}" \
         "${channel_dir}/node_modules/${dependency}"; \
     done \
  # Do not install each plugin's large OpenClaw peer dependency. The validated
  # global host is linked into the standalone /opt project instead.
  && if [ ! -e "${OPENCLAW_PLUGINS_DIR}/node_modules/openclaw" ]; then \
       ln -s /usr/local/lib/node_modules/openclaw "${OPENCLAW_PLUGINS_DIR}/node_modules/openclaw"; \
     fi \
  # OpenClaw's post-core plugin smoke check requires every official plugin
  # that declares the host as a peerDependency to resolve that peer from the
  # plugin's own node_modules. The host is installed globally, outside this
  # standalone /opt npm project, so npm cannot create these links itself.
  && for plugin in slack discord feishu whatsapp; do \
       plugin_dir="${OPENCLAW_PLUGINS_DIR}/node_modules/@openclaw/${plugin}"; \
       mkdir -p "${plugin_dir}/node_modules"; \
       if [ ! -e "${plugin_dir}/node_modules/openclaw" ]; then \
         ln -s /usr/local/lib/node_modules/openclaw "${plugin_dir}/node_modules/openclaw"; \
       fi; \
       test -f "${plugin_dir}/node_modules/openclaw/package.json"; \
     done \
  && node /app/scripts/patch-weixin-http-routes.js ${OPENCLAW_PLUGINS_DIR}/node_modules/@tencent-weixin/openclaw-weixin \
  && node /app/scripts/patch-weixin-access-policy.js ${OPENCLAW_PLUGINS_DIR}/node_modules/@tencent-weixin/openclaw-weixin \
  && test -f "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/runtime-events/package.json" \
  && test -f "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/clawrouters/openclaw.plugin.json" \
  && test -f "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel/openclaw.plugin.json" \
  && test -f "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/openclaw-search/openclaw.plugin.json" \
  && test -f "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/durable-work/openclaw.plugin.json" \
  && test -f "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/employee-catalog/openclaw.plugin.json" \
  && test -f "${OPENCLAW_PLUGINS_DIR}/node_modules/openclaw/package.json" \
  && node --input-type=module -e "import { createRequire } from 'node:module'; const rootRequire = createRequire('${OPENCLAW_PLUGINS_DIR}/package.json'); const channelRequire = createRequire('/usr/local/lib/node_modules/openclaw/dist/extensions/oneclaw-channel/package.json'); for (const dependency of ['@oneclaw-plugins/runtime-events', 'ajv', 'ws']) { const root = rootRequire.resolve(dependency); const channel = channelRequire.resolve(dependency); if (root !== channel) throw new Error('Bundled OneClaw Channel did not resolve shared ' + dependency); } const openclaw = channelRequire.resolve('openclaw'); if (!openclaw.startsWith('/usr/local/lib/node_modules/openclaw/')) throw new Error('Bundled OneClaw Channel did not resolve the global OpenClaw host');" \
  && node --input-type=module -e "import fs from 'node:fs'; import { createRequire } from 'node:module'; const require = createRequire('${OPENCLAW_PLUGINS_DIR}/package.json'); const channelPackage = JSON.parse(fs.readFileSync('${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel/package.json', 'utf8')); const versions = new Map([['clawrouters', '0.4.1'], ['channel', '0.1.5'], ['openclaw-search', '0.2.0'], ['durable-work', '0.9.1'], ['employee-catalog', '0.5.0']]); for (const [name, expected] of versions) { const pkg = JSON.parse(fs.readFileSync('${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/' + name + '/package.json', 'utf8')); if (pkg.version !== expected) throw new Error('Unexpected ' + name + ' version: ' + pkg.version); } if (require('@oneclaw-plugins/runtime-events').runtimeEventSdkVersion() !== '0.1.1') throw new Error('Unexpected Runtime Event SDK version'); if (channelPackage.peerDependencies.openclaw !== '2026.7.1') throw new Error('Unexpected OpenClaw peer version');" \
  # Do not leave ordinary copies behind: a persisted OpenClaw install index can
  # rediscover them with global origin and shadow the bundled trusted copies.
  && rm -rf \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel" \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/durable-work" \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/employee-catalog" \
  && test ! -e "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel" \
  && test ! -e "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/durable-work" \
  && test ! -e "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/employee-catalog" \
  && chmod -R a+rX ${OPENCLAW_PLUGINS_DIR}

COPY scripts ./scripts

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,target=/root/.local/share/pnpm/store/v3,sharing=locked \
  corepack enable \
  && pnpm install --frozen-lockfile --prod

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
