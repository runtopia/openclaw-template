import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Dockerfile installs unzip for custom skill archives", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("python3 ripgrep tmux unzip"));
});

test("Dockerfile preinstalls portable builtin skill dependencies", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  for (const aptPackage of ["ffmpeg", "gh", "jq", "ripgrep", "tmux"]) {
    assert.ok(dockerfile.includes(aptPackage), `${aptPackage} should be installed`);
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

test("cloud is the lean default while full retains extended skill tools", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^ARG ONECLAW_RUNTIME_PROFILE=cloud$/m);
  assert.match(dockerfile, /^ARG ONECLAW_DOCUMENT_SKILLS=0$/m);
  assert.ok(dockerfile.includes('if [ "${ONECLAW_RUNTIME_PROFILE}" = "full" ]'));
  assert.ok(dockerfile.includes("Skipping extended Go skill tools"));
  assert.ok(dockerfile.includes("Skipping extended agent CLIs"));
  assert.ok(dockerfile.includes("Skipping xurl"));
});

test("GitHub CI defaults Railway builds to the documents image type", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "docker.yml"), "utf8");
  assert.match(workflow, /default: documents/);
  assert.ok(workflow.includes("ONECLAW_RUNTIME_PROFILE=${{ steps.profile.outputs.runtime_profile }}"));
  assert.ok(workflow.includes("ONECLAW_DOCUMENT_SKILLS=${{ steps.profile.outputs.document_skills }}"));
  assert.ok(workflow.includes("type=raw,value=latest"));
  assert.ok(workflow.includes("type=raw,value=documents"));
});

test("Dockerfile bundles the pinned Desktop common skills outside the data volume", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  const skillsRoot = path.join(repoRoot, "resources", "preinstalled-skills");
  const manifest = JSON.parse(fs.readFileSync(
    path.join(skillsRoot, ".preinstalled-manifest.json"),
    "utf8",
  ));
  const lock = JSON.parse(fs.readFileSync(
    path.join(skillsRoot, ".preinstalled-lock.json"),
    "utf8",
  ));
  const expected = ["pdf", "xlsx", "docx", "pptx", "find-skills", "self-improving-agent"];

  assert.ok(dockerfile.includes("COPY resources/preinstalled-skills ${ONECLAW_PREINSTALLED_SKILLS_DIR}"));
  assert.deepEqual(manifest.skills.map((skill) => skill.slug), expected);
  assert.deepEqual(lock.skills.map((skill) => skill.slug), expected);
  for (const skill of manifest.skills) {
    assert.match(skill.ref, /^[0-9a-f]{40}$/u);
    assert.equal(skill.version, skill.ref);
    assert.equal(lock.skills.find((entry) => entry.slug === skill.slug)?.commit, skill.ref);
    assert.ok(fs.existsSync(path.join(skillsRoot, skill.slug, "SKILL.md")));
  }
  const bundledTests = fs.readdirSync(skillsRoot, { recursive: true })
    .filter((entry) => /(?:^|\/)test(?:s)?\/|\.test\.[cm]?[jt]s$/u.test(String(entry)));
  assert.deepEqual(bundledTests, [], "runtime skill bundles should not ship upstream test fixtures");
});

test("startup ownership repair is recursive only for a one-time migration", () => {
  const startup = fs.readFileSync(path.join(repoRoot, "start.sh"), "utf8");
  assert.ok(startup.includes('OWNERSHIP_MARKER="$STATE_DIR/.oneclaw-ownership-v1"'));
  assert.match(startup, /if \[ ! -f "\$OWNERSHIP_MARKER" \]; then[\s\S]*chown -R/);
  assert.doesNotMatch(startup, /chown -R openclaw:openclaw \/data(?:\s|$)/);
});

test("Dockerfile includes complete Linux template skill dependencies", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^FROM node:24\.15\.0-bookworm$/m);
  for (const aptPackage of ["poppler-utils", "qpdf", "tesseract-ocr", "python3-venv"]) {
    assert.ok(dockerfile.includes(aptPackage), `${aptPackage} should be available in document/full builds`);
  }
  assert.ok(dockerfile.includes('[ "${ONECLAW_DOCUMENT_SKILLS}" = "1" ]'));
  assert.ok(dockerfile.includes("@steipete/summarize@${SUMMARIZE_VERSION}"));
  assert.ok(dockerfile.includes("ARG SUMMARIZE_VERSION=0.11.1"));
  assert.ok(dockerfile.includes("github.com/steipete/gogcli/cmd/gog@v0.9.0"));
  assert.ok(dockerfile.includes("ARG HIMALAYA_VERSION=1.2.0"));
  assert.ok(dockerfile.includes("himalaya.${archive_arch}-linux.tgz"));
  assert.ok(dockerfile.includes("sha256sum -c -"));
  assert.ok(dockerfile.includes("ARG OP_VERSION=2.35.0"));
  assert.ok(dockerfile.includes("FROM 1password/op:${OP_VERSION} AS builtin-skill-onepassword-source"));
  assert.ok(dockerfile.includes("COPY --from=builtin-skill-onepassword /out/ /usr/local/bin/"));
  assert.ok(dockerfile.includes("nano-pdf==0.2.1"));
  const documentPythonStart = dockerfile.indexOf("    python3 -m venv /opt/oneclaw-python;");
  const documentPythonEnd = dockerfile.indexOf("  fi;", documentPythonStart);
  const documentPythonBlock = dockerfile.slice(documentPythonStart, documentPythonEnd);
  assert.doesNotMatch(documentPythonBlock, /nano-pdf/, "documents should use the broad pdf skill only");
  const fullPythonStart = dockerfile.indexOf('  if [ "${ONECLAW_RUNTIME_PROFILE}" = "full" ]; then', documentPythonEnd);
  const fullPythonEnd = dockerfile.indexOf("  fi", fullPythonStart);
  assert.match(dockerfile.slice(fullPythonStart, fullPythonEnd), /nano-pdf==0\.2\.1/);
  assert.ok(dockerfile.includes("ARG UV_VERSION=0.8.14"));
  assert.ok(dockerfile.includes("uv==${UV_VERSION}"));
  for (const pythonPackage of [
    "openpyxl==3.1.5",
    "python-pptx==1.0.2",
    "pypdf==6.15.0",
    "reportlab==5.0.0",
    "pdfplumber==0.11.10",
  ]) {
    assert.ok(dockerfile.includes(pythonPackage), `${pythonPackage} should be installed`);
  }
  const skillRuntime = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "resources", "preinstalled-skill-runtime", "package.json"),
    "utf8",
  ));
  const skillRuntimeLock = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "resources", "preinstalled-skill-runtime", "package-lock.json"),
    "utf8",
  ));
  assert.equal(skillRuntime.dependencies.docx, "9.7.1");
  assert.equal(skillRuntime.dependencies.pptxgenjs, "4.0.1");
  assert.equal(skillRuntimeLock.lockfileVersion, 3);
  assert.equal(skillRuntimeLock.packages["node_modules/docx"].version, "9.7.1");
  assert.equal(skillRuntimeLock.packages["node_modules/pptxgenjs"].version, "4.0.1");
  assert.ok(dockerfile.includes("npm ci --omit=dev --no-audit --no-fund"));
  assert.ok(dockerfile.includes("NODE_PATH=/opt/oneclaw-preinstalled-skill-runtime/node_modules"));
  assert.ok(dockerfile.includes("/opt/oneclaw-python/bin"));
});

test("image includes a Linux template skill smoke verifier", () => {
  const script = fs.readFileSync(path.join(repoRoot, "scripts/verify-linux-template-skills.sh"), "utf8");
  assert.match(script, /openclaw skills list --agent main --json/);
  for (const binary of ["summarize", "gog", "himalaya", "nano-pdf", "uv", "qpdf", "pptxgenjs"]) {
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
    "npm-backed OneClaw packages must bypass mirrors that may not have synchronized new releases",
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
  const clawroutersVersion = pluginBundle.dependencies["@oneclaw-plugins/clawrouters"];
  assert.match(
    clawroutersVersion,
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "ClawRouters should use an exact official npm package version",
  );
  const lockfile = JSON.parse(fs.readFileSync(
    path.join(repoRoot, "resources", "openclaw-plugin-bundle", "package-lock.json"),
    "utf8",
  ));
  const clawroutersLock = lockfile.packages["node_modules/@oneclaw-plugins/clawrouters"];
  assert.equal(clawroutersLock.version, clawroutersVersion);
  assert.equal(
    clawroutersLock.resolved,
    `https://registry.npmjs.org/@oneclaw-plugins/clawrouters/-/clawrouters-${clawroutersVersion}.tgz`,
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
    dockerfile.includes("ARG CACHEBUST_PLUGINS=v14"),
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
  const verifier = fs.readFileSync(
    path.join(repoRoot, "scripts", "verify-openclaw-plugin-bundle.mjs"),
    "utf8",
  );
  assert.ok(dockerfile.includes("@oneclaw-plugins/runtime-events"));
  assert.ok(verifier.includes('readInstalledPackage("@oneclaw-plugins/channel")'));
  assert.ok(verifier.includes("installedVersion !== lockedVersion"));
  assert.match(dockerfile, /^ENV ONECLAW_INTERNAL_CHANNEL_V2=1$/m);
  assert.ok(dockerfile.includes(
    "patch-oneclaw-channel-delivery.mjs",
  ));
  assert.ok(dockerfile.includes(
    "verify-openclaw-plugin-bundle.mjs",
  ));
  assert.ok(dockerfile.includes("root !== channel"));
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
