ARG OP_VERSION=2.35.0
ARG ONECLAW_RUNTIME_PROFILE=standard
ARG OPENCLAW_VERSION=2026.7.1-2
ARG IMAGE_VERSION=2026.7.1-2

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
RUN set -eu; \
  mkdir -p /out; \
  case "${TARGETARCH}" in \
    amd64) archive_arch=x86_64; archive_sha=e04e6382e3e664ef34b01afa1a2216113194a2975d2859727647b22d9b36d4e4 ;; \
    arm64) archive_arch=aarch64; archive_sha=643020b220991fac67726f3be11310fcf806e757feadbbab3efbddd713597872 ;; \
    *) echo "unsupported Himalaya target architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/himalaya.tgz \
    "https://github.com/pimalaya/himalaya/releases/download/v${HIMALAYA_VERSION}/himalaya.${archive_arch}-linux.tgz"; \
  echo "${archive_sha}  /tmp/himalaya.tgz" | sha256sum -c -; \
  tar -xzf /tmp/himalaya.tgz -C /out himalaya

FROM 1password/op:${OP_VERSION} AS builtin-skill-onepassword-source
FROM node:24.15.0-bookworm AS builtin-skill-onepassword
COPY --from=builtin-skill-onepassword-source /usr/local/bin/op /tmp/op
RUN mkdir -p /out && cp /tmp/op /out/op

# OpenClaw 2026.7.1 requires a Node build with a WAL-reset-safe embedded
# SQLite. Keep the Runtime image on the same version used by Channel CI.
FROM node:24.15.0-bookworm AS runtime-standard

ENV ONECLAW_RUNTIME_PROFILE=standard
ENV ONECLAW_DOCUMENT_SKILLS=1
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
  && runtime_packages="ca-certificates curl ffmpeg gh git gosu jq procps python3 python3-venv ripgrep tmux unzip poppler-utils qpdf tesseract-ocr" \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${runtime_packages}

# Pin OpenClaw core to the same runtime shipped by OneClaw Desktop. The
# sidecar's runtime patches and first-party plugins are validated against this
# exact host version.
ARG OPENCLAW_VERSION
ENV OPENCLAW_VERSION=${OPENCLAW_VERSION}
ARG MCPORTER_VERSION=0.12.3
ARG SUMMARIZE_VERSION=0.11.1
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install -g --prefer-offline --no-audit --no-fund \
      openclaw@${OPENCLAW_VERSION} \
      mcporter@${MCPORTER_VERSION} \
      @steipete/summarize@${SUMMARIZE_VERSION}

ARG UV_VERSION=0.8.14
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
  python3 -m venv /opt/oneclaw-python; \
  /opt/oneclaw-python/bin/pip install --index-url "${PIP_INDEX_URL}" \
    openpyxl==3.1.5 \
    python-pptx==1.0.2 \
    pypdf==6.15.0 \
    reportlab==5.0.0 \
    pdfplumber==0.11.10
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
#   ClawRouters and Search are exact npm packages published from
#   runtopia/oneclaw-plugins. An unreleased Channel build may instead be a
#   content-addressed local tgz tracked by the same locked bundle. Employee
#   orchestration uses OpenClaw's native
#   Agent Sessions, Background Tasks, Workboard, and update_plan capabilities.
#   Exact top-level versions and their complete dependency graph are locked in
#   resources/openclaw-plugin-bundle/package-lock.json.
#
# CACHEBUST_PLUGINS: increment to force-reinstall all plugins (e.g. after
# pinning a new version or when the layer is stale from a prior @latest build).
ARG CACHEBUST_PLUGINS=v14
ENV OPENCLAW_PLUGINS_DIR=/opt/openclaw-plugins
# Internal Channel v2 is the only production transport. The API exposes the
# versioned /api/v2/internal/channel/* contract and Redis-woken long polling.
ENV ONECLAW_INTERNAL_CHANNEL_V2=1
WORKDIR /app
COPY scripts/patch-openclaw-chat-images.js \
     scripts/patch-openclaw-assistant-media-agent-roots.js \
     scripts/patch-openclaw-composio-url-redaction.js \
     scripts/patch-openclaw-memory-migration.mjs \
     scripts/patch-openclaw-realtime-base-url.mjs \
     scripts/patch-openclaw-oneclaw-completion-delivery.mjs \
     scripts/patch-oneclaw-channel-delivery.mjs \
     scripts/verify-openclaw-plugin-bundle.mjs \
     scripts/patch-weixin-http-routes.js \
     scripts/patch-weixin-access-policy.js \
     ./scripts/
# OpenClaw saves chat.send images but does not pass the managed path to the
# current agent; keep the existing fail-closed patch until upstream removes
# the matching bundle anchors.
RUN node /app/scripts/patch-openclaw-chat-images.js /usr/local/lib/node_modules/openclaw
# The upstream Control UI scopes assistant-media to the default agent even
# when a signed-in user is viewing another configured agent. Keep the route
# authenticated, but let callers select another configured agent so its exact
# workspace root can be added without opening arbitrary filesystem paths.
RUN node /app/scripts/patch-openclaw-assistant-media-agent-roots.js /usr/local/lib/node_modules/openclaw
RUN node /app/scripts/patch-openclaw-composio-url-redaction.js /usr/local/lib/node_modules/openclaw
# OpenClaw 2026.7.1 can leave duplicate legacy Memory Core state in place,
# causing its strict startup migration checkpoint to fail on every restart.
RUN node /app/scripts/patch-openclaw-memory-migration.mjs /usr/local/lib/node_modules/openclaw/dist
# OpenClaw 2026.7.1 hardcodes api.openai.com for the native OpenAI Realtime
# bridge. Preserve the native Talk protocol while allowing the managed
# ClawRouters provider to supply its authenticated /api/v1 WebSocket base.
RUN node /app/scripts/patch-openclaw-realtime-base-url.mjs /usr/local/lib/node_modules/openclaw/dist
# Detached generated-media completions must enter OneClaw through the durable
# Message Tool path, and OneClaw sources must bypass OpenClaw's private
# internal-ui reply sink, so Channel can allocate an autonomous public Run.
RUN node /app/scripts/patch-openclaw-oneclaw-completion-delivery.mjs /usr/local/lib/node_modules/openclaw
# The template is a package consumer. Plugin source, manifests, and internal
# dependency declarations stay in their own packages; this lockfile pins the
# exact npm or content-addressed local artifacts consumed by the cloud Runtime
# image.
ARG ONECLAW_NPM_REGISTRY=https://registry.npmjs.org
COPY resources/openclaw-plugin-bundle /tmp/openclaw-plugin-bundle
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  test -n "${CACHEBUST_PLUGINS}" \
  && cd /tmp/openclaw-plugin-bundle \
  && npm ci --registry="${ONECLAW_NPM_REGISTRY}" --omit=dev --legacy-peer-deps --no-audit --no-fund \
  && mkdir -p ${OPENCLAW_PLUGINS_DIR}/node_modules \
  && cp package.json package-lock.json ${OPENCLAW_PLUGINS_DIR}/ \
  && cp -a node_modules/. ${OPENCLAW_PLUGINS_DIR}/node_modules/ \
  # Keep generic text, image, and file delivery on message(action=send).
  # Provider-specific actions such as sendAttachment are not Channel-neutral.
  && node /app/scripts/patch-oneclaw-channel-delivery.mjs \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel" \
  # Channel calls privileged Gateway APIs. Copy its exact locked package into
  # OpenClaw's immutable bundled tree so the host grants native bundled-plugin
  # trust without weakening its trust checks.
  && cp -a "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel" \
       /usr/local/lib/node_modules/openclaw/dist/extensions/oneclaw-channel \
  && for plugin in oneclaw-channel; do \
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
  # OpenClaw 2026.7.1-2 audits every SQLite-indexed plugin that declares an
  # openclaw peerDependency at <plugin>/node_modules/openclaw. A project-root
  # link is sufficient for Node resolution but not for this strict payload
  # smoke check, so link the global host inside every external preinstalled
  # plugin recorded by src/config/plugin-install-index.js.
  && for plugin_dir in \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/clawrouters" \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/openclaw-search" \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@openclaw/slack" \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@openclaw/discord" \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@openclaw/feishu" \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@openclaw/whatsapp" \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@tencent-weixin/openclaw-weixin"; do \
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
  && test -f "${OPENCLAW_PLUGINS_DIR}/node_modules/openclaw/package.json" \
  && node --input-type=module -e "import { createRequire } from 'node:module'; const rootRequire = createRequire('${OPENCLAW_PLUGINS_DIR}/package.json'); const channelRequire = createRequire('/usr/local/lib/node_modules/openclaw/dist/extensions/oneclaw-channel/package.json'); for (const dependency of ['@oneclaw-plugins/runtime-events', 'ajv', 'ws']) { const root = rootRequire.resolve(dependency); const channel = channelRequire.resolve(dependency); if (root !== channel) throw new Error('Bundled OneClaw Channel did not resolve shared ' + dependency); } const openclaw = channelRequire.resolve('openclaw'); if (!openclaw.startsWith('/usr/local/lib/node_modules/openclaw/')) throw new Error('Bundled OneClaw Channel did not resolve the global OpenClaw host');" \
  && node /app/scripts/verify-openclaw-plugin-bundle.mjs \
       "${OPENCLAW_PLUGINS_DIR}" "2026.7.1" \
  # Do not leave ordinary copies behind: a persisted OpenClaw install index can
  # rediscover them with global origin and shadow the bundled trusted copies.
  && rm -rf \
       "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel" \
  && test ! -e "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel" \
  && chmod -R a+rX ${OPENCLAW_PLUGINS_DIR}

COPY scripts ./scripts
RUN node /app/scripts/openclaw-gateway-fast.mjs --check

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY patches ./patches
RUN --mount=type=cache,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,target=/root/.local/share/pnpm/store/v3,sharing=locked \
  corepack enable \
  && pnpm install --frozen-lockfile --prod

# Keep the small document runtime and skill content after the much larger
# plugin/app dependency layers. Updating a skill must not invalidate the
# locked channel plugin installation cache.
COPY resources/preinstalled-skill-runtime /tmp/oneclaw-preinstalled-skill-runtime
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  set -eu; \
  cd /tmp/oneclaw-preinstalled-skill-runtime; \
  npm ci --omit=dev --no-audit --no-fund; \
  mv /tmp/oneclaw-preinstalled-skill-runtime /opt/oneclaw-preinstalled-skill-runtime; \
  chmod -R a+rX /opt/oneclaw-preinstalled-skill-runtime
ENV NODE_PATH=/opt/oneclaw-preinstalled-skill-runtime/node_modules

# Small, commit-pinned common skills shared with OneClaw Desktop. Definitions
# stay in immutable /opt and never copy into the Railway volume. The default
# standard image enables the common and document skills used by most employees.
ENV ONECLAW_PREINSTALLED_SKILLS_DIR=/opt/oneclaw-skills
COPY resources/preinstalled-skills ${ONECLAW_PREINSTALLED_SKILLS_DIR}
RUN test -f ${ONECLAW_PREINSTALLED_SKILLS_DIR}/.preinstalled-manifest.json \
  && test -f ${ONECLAW_PREINSTALLED_SKILLS_DIR}/.preinstalled-lock.json \
  && for skill in pdf xlsx docx pptx find-skills self-improving-agent; do \
       test -f "${ONECLAW_PREINSTALLED_SKILLS_DIR}/${skill}/SKILL.md"; \
     done \
  && chmod -R a+rX ${ONECLAW_PREINSTALLED_SKILLS_DIR}

# Cache buster - change this to force rebuild
ARG CACHEBUST=v20260212-chromium

COPY src ./src
COPY start.sh ./start.sh

RUN useradd -m -s /bin/bash openclaw \
  && chown -R openclaw:openclaw /app \
  && mkdir -p /data \
  && chmod +x /app/start.sh /app/scripts/verify-linux-template-skills.sh

# Image version — pass at build time: docker build --build-arg IMAGE_VERSION=1.2.3
ARG IMAGE_VERSION
ENV IMAGE_VERSION=${IMAGE_VERSION}
ENV ONECLAW_RUNTIME_CONTRACT=1
RUN node /app/scripts/write-runtime-capabilities.mjs standard /opt/oneclaw/runtime-capabilities.json
LABEL org.opencontainers.image.version=${IMAGE_VERSION} \
      io.oneclaw.runtime.profile=standard

ENV PORT=8080
ENV OPENCLAW_ENTRY=/usr/local/lib/node_modules/openclaw/dist/entry.js
ENV ONECLAW_FAST_GATEWAY_ENTRY=/app/scripts/openclaw-gateway-fast.mjs
EXPOSE 8080

# /health is the wrapper liveness endpoint; it remains available while the
# internal Gateway is warming up and reports gatewayReady in its JSON body.
HEALTHCHECK --interval=5s --timeout=2s --start-period=2s \
  CMD curl -fsS http://localhost:${PORT}/health >/dev/null || exit 1

# CMD runs as root so start.sh can fix /data ownership on Railway volume mounts,
# then drops to the non-root openclaw user via gosu.
CMD ["/bin/bash", "/app/start.sh"]

# Backward-compatible names. Both now resolve to the production standard
# runtime so an old build command cannot accidentally omit document support.
FROM runtime-standard AS runtime-cloud
FROM runtime-standard AS runtime-documents

# Full is an additive image. Every standard layer remains byte-for-byte
# reusable, while browser automation and specialist CLIs live in new layers.
FROM runtime-standard AS runtime-full

ENV ONECLAW_RUNTIME_PROFILE=full
ENV ONECLAW_DOCUMENT_SKILLS=1

ARG DEBIAN_MIRROR=https://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=https://mirrors.aliyun.com/debian-security
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
  sed -i \
    -e "s|http://deb.debian.org/debian-security|${DEBIAN_SECURITY_MIRROR}|g" \
    -e "s|http://deb.debian.org/debian|${DEBIAN_MIRROR}|g" \
    /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       build-essential libnss3 libnspr4 libatk1.0-0 libdrm2 libxcomposite1 \
       libxdamage1 libxrandr2 libgbm1 libxss1 libasound2 libgtk-3-0 \
       libxshmfence1 libgconf-2-4 libxtst6 libatspi2.0-0 libxkbcommon0 \
       fonts-liberation

ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG CLAWHUB_VERSION=0.23.1
ARG CODEX_VERSION=0.144.4
ARG GEMINI_CLI_VERSION=0.50.0
ARG ORACLE_VERSION=0.16.0
ARG XURL_VERSION=1.2.2
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  npm install -g --prefer-offline --no-audit --no-fund \
    clawhub@${CLAWHUB_VERSION} \
    @openai/codex@${CODEX_VERSION} \
    @google/gemini-cli@${GEMINI_CLI_VERSION} \
    @steipete/oracle@${ORACLE_VERSION} \
  && for attempt in 1 2 3; do \
       if npm install -g --prefer-offline --no-audit --no-fund @xdevplatform/xurl@${XURL_VERSION}; then \
         break; \
       fi; \
       if [ "${attempt}" -eq 3 ]; then \
         echo "xurl install failed after ${attempt} attempts" >&2; \
         exit 1; \
       fi; \
       sleep $((attempt * 5)); \
     done

COPY --from=builtin-skill-go-tools /out/ /usr/local/bin/
COPY --from=builtin-skill-himalaya /out/ /usr/local/bin/
COPY --from=builtin-skill-onepassword /out/ /usr/local/bin/

ARG UV_VERSION=0.8.14
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
  /opt/oneclaw-python/bin/pip install --index-url "${PIP_INDEX_URL}" \
    nano-pdf==0.2.1 \
    uv==${UV_VERSION}

RUN node /app/scripts/write-runtime-capabilities.mjs full /opt/oneclaw/runtime-capabilities.json
LABEL io.oneclaw.runtime.profile=full

FROM runtime-${ONECLAW_RUNTIME_PROFILE} AS runtime-final
