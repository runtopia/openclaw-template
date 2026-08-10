import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Dockerfile installs unzip for custom skill archives", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^\s*unzip\s*\\$/m);
});

test("Dockerfile preinstalls portable builtin skill dependencies", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  for (const aptPackage of ["ffmpeg", "gh", "jq", "ripgrep", "tmux"]) {
    assert.match(dockerfile, new RegExp(`^\\s*${aptPackage}\\s*\\\\$`, "m"));
  }
  for (const npmPackage of [
    "clawhub@${CLAWHUB_VERSION}",
    "@openai/codex@${CODEX_VERSION}",
    "@google/gemini-cli@${GEMINI_CLI_VERSION}",
    "mcporter@${MCPORTER_VERSION}",
    "@steipete/oracle@${ORACLE_VERSION}",
    "@xdevplatform/xurl@${XURL_VERSION}",
  ]) {
    assert.ok(dockerfile.includes(npmPackage), `${npmPackage} should be installed`);
  }
  assert.match(
    dockerfile,
    /RUN --mount=type=cache,target=\/root\/\.npm,sharing=locked \\\n\s+npm install -g --prefer-offline --no-audit --no-fund/,
    "global Node tools should reuse the BuildKit npm cache",
  );
  assert.match(
    dockerfile,
    /for attempt in 1 2 3; do[\s\S]*npm install -g --prefer-offline --no-audit --no-fund[\s\S]*@xdevplatform\/xurl@\$\{XURL_VERSION\}[\s\S]*xurl install failed after/,
    "xurl's GitHub binary download should be retried independently",
  );
  for (const module of ["blogwatcher", "blucli", "eightctl", "gifgrep", "ordercli", "sonoscli", "wacli"]) {
    assert.ok(dockerfile.includes(`/${module}/`), `${module} should be built`);
  }
  assert.ok(
    dockerfile.includes("github.com/openclaw/wacli/cmd/wacli@v0.12.0"),
    "wacli must use the module path declared by v0.12.0",
  );
  assert.ok(!dockerfile.includes("github.com/steipete/wacli/"));
});

test("Dockerfile includes complete Linux template skill dependencies", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24\.15\.0-bookworm$/m);
  for (const aptPackage of ["poppler-utils", "tesseract-ocr", "python3-venv"]) {
    assert.match(dockerfile, new RegExp(`^\\s*${aptPackage}\\s*\\\\$`, "m"));
  }
  assert.ok(dockerfile.includes("@steipete/summarize@${SUMMARIZE_VERSION}"));
  assert.ok(dockerfile.includes("ARG SUMMARIZE_VERSION=0.11.1"));
  assert.ok(dockerfile.includes("github.com/steipete/gogcli/cmd/gog@v0.9.0"));
  assert.ok(dockerfile.includes("ARG HIMALAYA_VERSION=1.2.0"));
  assert.ok(dockerfile.includes("himalaya.${archive_arch}-linux.tgz"));
  assert.ok(dockerfile.includes("sha256sum -c -"));
  assert.ok(dockerfile.includes("ARG OP_VERSION=2.35.0"));
  assert.ok(dockerfile.includes("FROM 1password/op:${OP_VERSION} AS builtin-skill-onepassword"));
  assert.ok(dockerfile.includes("COPY --from=builtin-skill-onepassword /usr/local/bin/op /usr/local/bin/op"));
  assert.ok(dockerfile.includes("nano-pdf==0.2.1"));
  assert.ok(dockerfile.includes("ARG UV_VERSION=0.8.14"));
  assert.ok(dockerfile.includes("uv==${UV_VERSION}"));
  assert.ok(dockerfile.includes("/opt/oneclaw-python/bin"));
});

test("image includes a Linux template skill smoke verifier", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts/verify-linux-template-skills.sh"), "utf8");
  assert.match(script, /openclaw skills list --agent main --json/);
  for (const binary of ["summarize", "gog", "himalaya", "nano-pdf", "uv"]) {
    assert.ok(script.includes(binary), `${binary} should be verified`);
  }
  assert.doesNotMatch(script, /apple-notes|apple-reminders|things-mac/);
});

test("Dockerfile installs the locked plugin bundle outside the data volume", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("COPY resources/openclaw-plugin-bundle /tmp/openclaw-plugin-bundle"));
  assert.ok(dockerfile.includes("ARG ONECLAW_NPM_REGISTRY=https://registry.npmjs.org"));
  assert.ok(
    dockerfile.includes('npm ci --registry="${ONECLAW_NPM_REGISTRY}" --omit=dev --legacy-peer-deps'),
    "official OneClaw packages must bypass mirrors that may not have synchronized new releases",
  );
  assert.ok(dockerfile.includes("cp -a node_modules/. ${OPENCLAW_PLUGINS_DIR}/node_modules/"));
  assert.ok(!dockerfile.includes("COPY resources/openclaw-plugins"));
  assert.ok(!dockerfile.includes("COPY resources/oneclaw-packages"));
});

test("Dockerfile aligns OpenClaw core to Desktop 2026.7.1-2", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const pluginBundle = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "resources", "openclaw-plugin-bundle", "package.json"),
    "utf8",
  ));
  assert.ok(dockerfile.includes("ARG OPENCLAW_VERSION=2026.7.1-2"));
  assert.equal(
    pluginBundle.dependencies["@oneclaw-plugins/clawrouters"],
    "0.4.1",
    "ClawRouters should use the exact official npm package version",
  );
  const lockfile = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "resources", "openclaw-plugin-bundle", "package-lock.json"),
    "utf8",
  ));
  const clawroutersLock = lockfile.packages["node_modules/@oneclaw-plugins/clawrouters"];
  assert.equal(clawroutersLock.version, "0.4.1");
  assert.match(
    clawroutersLock.resolved,
    /^https:\/\/registry\.npmjs\.org\/@oneclaw-plugins\/clawrouters\/-\/clawrouters-0\.4\.1\.tgz$/u,
    "ClawRouters lock entry must resolve from npmjs",
  );
  for (const plugin of ["slack", "discord", "feishu", "whatsapp"]) {
    assert.equal(
      pluginBundle.dependencies[`@openclaw/${plugin}`],
      "2026.7.1",
      `@openclaw/${plugin} should match the host runtime`,
    );
  }
  for (const packagePath of [
    "@oneclaw-plugins/clawrouters",
    "@oneclaw-plugins/openclaw-search",
    "@openclaw/slack",
    "@openclaw/discord",
    "@openclaw/feishu",
    "@openclaw/whatsapp",
    "@tencent-weixin/openclaw-weixin",
  ]) {
    assert.ok(
      dockerfile.includes(`"${'${OPENCLAW_PLUGINS_DIR}'}/node_modules/${packagePath}"`),
      `${packagePath} should receive a plugin-local OpenClaw peer link`,
    );
  }
  assert.ok(
    dockerfile.includes(
      'ln -s /usr/local/lib/node_modules/openclaw "${plugin_dir}/node_modules/openclaw"',
    ),
    "all SQLite-indexed plugins should resolve their globally installed OpenClaw peer",
  );
  assert.ok(
    dockerfile.includes(
      'test -f "${plugin_dir}/node_modules/openclaw/package.json"',
    ),
    "the image build should fail if an indexed plugin cannot resolve its OpenClaw peer",
  );
  assert.ok(
    dockerfile.includes("ARG CACHEBUST_PLUGINS=v13"),
    "the fixed plugin filesystem layer must not reuse the pre-fix build cache",
  );
  assert.ok(
    dockerfile.includes('test -n "${CACHEBUST_PLUGINS}"'),
    "the plugin install layer should consume its cache-buster argument",
  );
});

test("Dockerfile patches Memory Core without bundling retired collaboration plugins", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes(
    "RUN node /app/scripts/patch-openclaw-memory-migration.mjs /usr/local/lib/node_modules/openclaw/dist",
  ));
  assert.ok(!dockerfile.includes("@oneclaw-plugins/durable-work"));
  assert.ok(!dockerfile.includes("@oneclaw-plugins/employee-catalog"));
  assert.ok(!dockerfile.includes("dist/extensions/oneclaw-workflows"));
  assert.ok(!dockerfile.includes("dist/extensions/oneclaw-employee-catalog"));
});

test("Dockerfile installs official OneClaw packages beside one shared Runtime Event SDK", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("@oneclaw-plugins/runtime-events"));
  assert.ok(dockerfile.includes("@oneclaw-plugins/channel/package.json"));
  assert.ok(dockerfile.includes(
    "patch-oneclaw-channel-delivery.mjs",
  ));
  assert.ok(dockerfile.includes("root !== channel"));
  assert.ok(dockerfile.includes("['channel', '0.1.13']"));
  assert.ok(dockerfile.includes("runtimeEventSdkVersion() !== '0.1.2'"));
  assert.ok(dockerfile.includes("['clawrouters', '0.4.1']"));
  assert.ok(dockerfile.includes("['openclaw-search', '0.2.0']"));
  assert.ok(!dockerfile.includes("@oneclaw/channel"));
});

test("Dockerfile gives privileged OneClaw Channel native bundled-plugin trust", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

  assert.ok(
    dockerfile.includes(
      "/usr/local/lib/node_modules/openclaw/dist/extensions/oneclaw-channel",
    ),
  );
  assert.ok(
    dockerfile.includes(
      'test ! -e "${OPENCLAW_PLUGINS_DIR}/node_modules/@oneclaw-plugins/channel"',
    ),
  );
  assert.ok(dockerfile.includes(
    '"${channel_dir}/node_modules/@oneclaw-plugins/runtime-events"',
  ));
  assert.ok(dockerfile.includes("channelRequire.resolve('openclaw')"));
});
