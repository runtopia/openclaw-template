# openclaw-template-v2 精简重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `openclaw-template` (v1) 精简重构进 `openclaw-template-v2`：功能不变，去掉 setup 向导 / tui / node-pty / 遗留 server.js，合并三套配置路径，拆分 repair.js，重排为清晰分层目录。

**Architecture:** 采用「复制 v1 → 原地裁剪重构」策略：先整仓复制以自动保住所有血泪 quirk 与可跑测试，再按新目录逐模块 `git mv` + 改 import + 删除，每步跑测试保持绿灯。绝不重敲既有逻辑，只搬迁、拆分、删除。

**Tech Stack:** Node.js (ESM, node:test), Express 5, http-proxy, ws；Docker + Railway 部署。

**参考文档:** 设计 spec `docs/superpowers/specs/2026-07-03-openclaw-template-v2-refactor-design.md`（含第 4 节 12 条不变量、第 3 节对接契约）。

---

## 文件结构（迁移映射）

| v2 目标 | v1 来源 | 动作 |
|---|---|---|
| `src/index.js` | `src/sidecar.js` | 搬迁+抽出 proxy/auth |
| `src/config/generate.js` | `src/lib/direct-config.js`(+auto/init 合并) | 合并 |
| `src/config/runtime-defaults.js` | 从 direct-config.js 拆 | 拆分 |
| `src/config/plugins.js` | `src/lib/preinstalled-plugins.js` | 改名 |
| `src/config/edit.js` | `src/lib/openclaw-config.js` | 改名 |
| `src/gateway/manager.js` | `src/lib/gateway.js` | 改名 |
| `src/gateway/rpc.js` | `src/lib/gateway-rpc.js` | 改名 |
| `src/channels/manifest.js` | `src/lib/channel-manifest.js` | 改名 |
| `src/channels/access-policy.js` | `src/lib/channel-access-policy.js` | 改名 |
| `src/channels/bindings.js` | `src/lib/channel-bindings.js` | 改名 |
| `src/channels/wechat-login.js` | `src/lib/wechat-login.js` | 改名 |
| `src/integration/oneclaw.js` | `src/lib/oneclaw-integration.js` | 改名 |
| `src/proxy/reverse-proxy.js` | 从 sidecar.js 抽出 | 新建 |
| `src/proxy/auth.js` | 从 sidecar.js 抽出 | 新建 |
| `src/repair/router.js` | `src/lib/routes/repair.js` 拆 | 拆分 |
| `src/repair/assistant.js` | repair.js AI 部分 | 拆分 |
| `src/repair/qr-login.js` | repair.js QR 部分 + wechat-login 调用 | 拆分 |
| `src/repair/config-ops.js` | repair.js config/bind 部分 | 拆分 |
| `src/repair/ai-key.js` | `src/lib/repair-ai-key.js` | 改名 |
| `src/skills/router.js` | `src/lib/routes/skills.js` | 改名 |
| `src/public/{login,loading}.html` | 同名 | 保留 |
| **删除** | `server.js` `init-config.js` `auto-config.js` `routes/setup.js` `routes/tui.js` `control-ui-config.js` `public/setup.html` `public/tui.html` | 删 |

---

## Task 0: 复制 v1 到 v2 并初始化 git 基线

**Files:**
- Create: 整个 `/Users/luopeng/vue/openclaw-template-v2/` 内容（从 v1 复制）

- [ ] **Step 1: 复制 v1 工作树（排除 node_modules/.git/临时数据）到 v2**

```bash
cd /Users/luopeng/vue
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.tmpdata' \
  openclaw-template/ openclaw-template-v2/
```

注意：v2 已有 `docs/superpowers/specs/` 和 `docs/superpowers/plans/` 两份新文件，rsync 不加 `--delete`，不会覆盖它们（v1 里没有同名文件）。

- [ ] **Step 2: 初始化 git 并装依赖**

```bash
cd /Users/luopeng/vue/openclaw-template-v2
git init -q
pnpm install
```

- [ ] **Step 3: 跑基线测试，确认复制体可用（全绿）**

Run: `cd /Users/luopeng/vue/openclaw-template-v2 && node --test`
Expected: 所有测试 PASS（与 v1 一致）。若有 FAIL，先修到与 v1 同等绿灯再继续。

- [ ] **Step 4: 提交基线**

```bash
git add -A
git commit -q -m "chore: import openclaw-template v1 as v2 refactor baseline"
```

---

## Task 1: 删除确定移除的模块（setup / tui / server / node-pty）

**Files:**
- Delete: `src/server.js` `src/init-config.js` `src/lib/routes/setup.js` `src/lib/routes/tui.js` `src/public/setup.html` `src/public/tui.html`
- Modify: `package.json`（去 node-pty + dev:server + lint 里的 server.js）

- [ ] **Step 1: 确认这些文件无被保留模块引用**

Run:
```bash
cd /Users/luopeng/vue/openclaw-template-v2
grep -rn "routes/setup\|routes/tui\|init-config\|server.js\|node-pty" src --include=*.js | grep -v "src/server.js\|src/init-config.js\|src/lib/routes/setup.js\|src/lib/routes/tui.js"
```
Expected: 无输出（除了下方将一并处理的 sidecar.js 对 setup 的挂载）。若 `sidecar.js` 引用了 setup/tui/init-config，记录行号，Step 3 处理。

- [ ] **Step 2: 删除文件**

```bash
git rm -q src/server.js src/init-config.js src/lib/routes/setup.js src/lib/routes/tui.js src/public/setup.html src/public/tui.html
```

- [ ] **Step 3: 从 sidecar.js 移除 setup/tui 挂载与 import**

在 `src/sidecar.js` 中删除：`createSkillsRouter` 保留但删除 setup 相关（`handleSetupConfigure`、`app.get("/setup"...)`、`app.post("/setup/api/configure"...)`）、任何 `routes/tui` 或 `routes/setup` 的 import。删除对 `generateConfigDirect` 在 setup handler 中的第二处调用（保留 ensureConfig 中的那处）。

Run 校验语法：`node -c src/sidecar.js`
Expected: 无报错。

- [ ] **Step 4: 修 package.json**

把 `dependencies` 中删除 `"node-pty"`；删除 `pnpm.onlyBuiltDependencies` 里的 `node-pty`（若整段为空则删整段）；`scripts` 删除 `"dev:server"`，`"lint"` 改为 `"node -c src/sidecar.js"`；`"name"` 改为 `"openclaw-template-v2"`。

```bash
pnpm install   # 刷新 lockfile，移除 node-pty
```

- [ ] **Step 5: 跑测试 + 语法检查**

Run: `node --test && node -c src/sidecar.js`
Expected: 全绿（tui/setup 无对应测试；whatsapp-login-route 等仍在）。若某测试 import 了已删文件，该测试也应删（确认其仅覆盖 setup/tui 后 `git rm`）。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -q -m "refactor: remove setup wizard, tui, legacy server.js and node-pty"
```

---

## Task 2: 建立分层目录并搬迁「直搬类」模块

「直搬类」= 只改路径不改逻辑的文件。用 `git mv` 保留历史。

**Files:**
- Move: 见下表

- [ ] **Step 1: 创建目录并 git mv 直搬文件**

```bash
cd /Users/luopeng/vue/openclaw-template-v2
mkdir -p src/config src/gateway src/channels src/integration src/proxy src/repair src/skills
git mv src/lib/preinstalled-plugins.js   src/config/plugins.js
git mv src/lib/openclaw-config.js         src/config/edit.js
git mv src/lib/gateway.js                 src/gateway/manager.js
git mv src/lib/gateway-rpc.js             src/gateway/rpc.js
git mv src/lib/channel-manifest.js        src/channels/manifest.js
git mv src/lib/channel-access-policy.js   src/channels/access-policy.js
git mv src/lib/channel-bindings.js        src/channels/bindings.js
git mv src/lib/wechat-login.js            src/channels/wechat-login.js
git mv src/lib/oneclaw-integration.js     src/integration/oneclaw.js
git mv src/lib/repair-ai-key.js           src/repair/ai-key.js
git mv src/lib/routes/skills.js           src/skills/router.js
```

- [ ] **Step 2: 全局改 import 路径**

对每个搬迁文件内部及其引用方，更新相对路径。逐一按被引用文件修正。用检索定位所有旧路径引用：

```bash
grep -rn "lib/preinstalled-plugins\|lib/openclaw-config\|lib/gateway\|lib/gateway-rpc\|lib/channel-manifest\|lib/channel-access-policy\|lib/channel-bindings\|lib/wechat-login\|lib/oneclaw-integration\|lib/repair-ai-key\|lib/routes/skills" src --include=*.js
```
逐条把引用改成新路径（如 `./lib/gateway.js` → `./gateway/manager.js`；模块间互引按新相对层级，如 `channels/access-policy.js` 引 `config/edit.js` 用 `../config/edit.js`）。

- [ ] **Step 3: 更新测试文件的 import 路径**

```bash
grep -rn "lib/" test --include=*.js
```
把 `test/*.js` 里指向 v1 `../src/lib/...` 的 import 改到新路径。

- [ ] **Step 4: 跑测试 + 语法检查**

Run: `node --test && node -c src/sidecar.js`
Expected: 全绿。逐个修红到绿。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -q -m "refactor: reorganize lib into config/gateway/channels/integration/skills layers"
```

---

## Task 3: 合并配置生成路径为 config/generate.js + runtime-defaults.js

v1 `direct-config.js` 是唯一被 sidecar 使用的路径（含 `generateConfigDirect` + `applyRuntimeDefaults` + `buildHttpEndpoints`）。`auto-config.js` 为遗留备选。目标：`direct-config.js` → `config/generate.js`，并把 `applyRuntimeDefaults` 拆到 `config/runtime-defaults.js`。

**Files:**
- Move: `src/lib/direct-config.js` → `src/config/generate.js`
- Create: `src/config/runtime-defaults.js`
- Delete: `src/lib/auto-config.js` `src/lib/control-ui-config.js`（并入 generate）
- Test: `test/clawrouters-base-url.test.js`（覆盖 runtime defaults / baseUrl）

- [ ] **Step 1: 确认 auto-config 无被保留模块引用**

Run: `grep -rn "auto-config\|control-ui-config" src --include=*.js`
Expected: 仅 `direct-config.js`/`sidecar.js`/被删文件引用。若 `direct-config.js` 引用了 `control-ui-config.js`，Step 4 合并其内容。

- [ ] **Step 2: git mv direct-config → config/generate.js，删 auto-config**

```bash
git mv src/lib/direct-config.js src/config/generate.js
git rm -q src/lib/auto-config.js
```

- [ ] **Step 3: 把 applyRuntimeDefaults 拆到 config/runtime-defaults.js**

从 `src/config/generate.js` 剪切 `applyRuntimeDefaults` 函数（及其私有辅助）到新文件 `src/config/runtime-defaults.js`，`export function applyRuntimeDefaults(...)`；在 `generate.js` 顶部 `import { applyRuntimeDefaults } from "./runtime-defaults.js";` 并重新 `export { applyRuntimeDefaults };`（保持对外 API 不变，避免改动 sidecar.js 的 import 名）。

- [ ] **Step 4: 若 control-ui-config.js 有独立逻辑，并入 generate.js 后删除**

检查 `src/lib/control-ui-config.js` 内容；若其函数被 generate 用到，复制进 generate.js 内部；否则确认无引用后：
```bash
git rm -q src/lib/control-ui-config.js
```

- [ ] **Step 5: 修所有 import（generate/runtime-defaults 新路径）**

```bash
grep -rn "lib/direct-config\|direct-config.js\|lib/control-ui-config" src test --include=*.js
```
`sidecar.js` 的 `import { applyRuntimeDefaults, generateConfigDirect } from "./lib/direct-config.js"` → `from "./config/generate.js"`。

- [ ] **Step 6: 跑测试**

Run: `node --test`
Expected: 全绿（含 clawrouters-base-url 覆盖 runtime defaults）。

- [ ] **Step 7: 提交**

```bash
git add -A && git commit -q -m "refactor: merge config paths into config/generate.js + runtime-defaults.js"
```

---

## Task 4: 拆分 repair.js 为 repair/ 子模块

v1 `src/lib/routes/repair.js`(791) 是 `createRepairRouter(deps)`，内含：AI 诊断 chat（SSE）、QR 登录（whatsapp/wechat）、config/bind 操作、restart/logs。目标拆为 `router.js`(装配) + `assistant.js`(AI) + `qr-login.js`(QR) + `config-ops.js`(config/bind)。

**Files:**
- Create: `src/repair/router.js` `src/repair/assistant.js` `src/repair/qr-login.js` `src/repair/config-ops.js`
- Delete: `src/lib/routes/repair.js`
- Test: `test/whatsapp-login-route.test.js`（覆盖 QR 路由）

- [ ] **Step 1: 读 repair.js，按职责标记每个 route handler 归属**

阅读 `src/lib/routes/repair.js`，把每个 `router.post/get(...)` 分类：`/chat`→assistant；`/whatsapp-login/*`、`/wechat-login*`→qr-login；`/bind-channel`、`/config`、`/restart`→config-ops。记录各 handler 用到的 deps（`getRepairAiKey`、`gatewayRpc`、`startWechatLogin`、`restartGateway`、`patchConfig` 等）。

- [ ] **Step 2: 建 config-ops.js（导出挂载函数）**

`src/repair/config-ops.js`：`export function mountConfigOps(router, deps) { ... }`，把 config/bind/restart handler 及其 import（`../channels/bindings.js`、`../config/edit.js`、`../channels/access-policy.js`）搬入。

- [ ] **Step 3: 建 qr-login.js**

`src/repair/qr-login.js`：`export function mountQrLogin(router, deps) { ... }`，搬入 whatsapp/wechat QR handler，import `../channels/wechat-login.js`、用 `deps.gatewayRpc`。

- [ ] **Step 4: 建 assistant.js**

`src/repair/assistant.js`：`export function mountAssistant(router, deps) { ... }`，搬入 `/chat` SSE 及 AI 工具（read_logs/get_status/restart_gateway 等），用 `deps.getRepairAiKey`、`deps.gatewayManager`。

- [ ] **Step 5: 建 router.js 装配**

`src/repair/router.js`：
```js
import express from "express";
import { mountAssistant } from "./assistant.js";
import { mountQrLogin } from "./qr-login.js";
import { mountConfigOps } from "./config-ops.js";

export function createRepairRouter(deps) {
  const router = express.Router();
  mountConfigOps(router, deps);
  mountQrLogin(router, deps);
  mountAssistant(router, deps);
  return router;
}
```
保持 `createRepairRouter(deps)` 签名与 v1 完全一致（sidecar.js 无需改调用）。

- [ ] **Step 6: 删旧文件，修 import**

```bash
git rm -q src/lib/routes/repair.js
grep -rn "routes/repair" src test --include=*.js
```
`sidecar.js`：`import { createRepairRouter } from "./lib/routes/repair.js"` → `from "./repair/router.js"`。

- [ ] **Step 7: 跑测试 + 语法检查**

Run: `node --test && node -c src/repair/router.js && node -c src/sidecar.js`
Expected: 全绿（whatsapp-login-route 测试通过）。

- [ ] **Step 8: 提交**

```bash
git add -A && git commit -q -m "refactor: split repair router into assistant/qr-login/config-ops"
```

---

## Task 5: 抽出 proxy/auth，把 sidecar.js 收敛为 index.js

sidecar.js(592) 里混着：鉴权（cookie/bearer/token）、反代（token 注入/forwarded 剥离）、路由装配、生命周期。抽出 `proxy/auth.js` + `proxy/reverse-proxy.js`，主文件更名 `index.js` 只做装配+启动。

**Files:**
- Create: `src/proxy/auth.js` `src/proxy/reverse-proxy.js`
- Move: `src/sidecar.js` → `src/index.js`
- Test: `test/gateway-manager.test.js` `test/gateway-rpc.test.js`（不受影响，回归用）

- [ ] **Step 1: 抽 auth.js**

新建 `src/proxy/auth.js`，导出工厂 `export function createAuth({ SETUP_PASSWORD, ONECLAW_INSTANCE_SECRET, GATEWAY_TOKEN, PORT })`，返回 `{ isAuthed, requireAuthPage, requireAuthApi, signSession, verifySession }`。把 sidecar.js 中 `AUTH_COOKIE`/`COOKIE_SECRET`/`signSession`/`verifySession`/`parseCookies`/`bearerMatchesSecret`/`queryTokenMatchesGateway`/`isAuthed`/`requireAuthPage`/`requireAuthApi` 整段搬入。**保持逻辑逐字不变**（这些是 quirk #2/#3 相关鉴权）。

- [ ] **Step 2: 抽 reverse-proxy.js**

新建 `src/proxy/reverse-proxy.js`，导出 `export function createReverseProxy({ GATEWAY_HOST, GATEWAY_PORT, GATEWAY_TOKEN, PROXY_TIMEOUT_MS })`，返回 `{ proxy, stripForwardedHeaders }`。把 `httpProxy.createProxyServer(...)`、`proxy.on("proxyReq"/"proxyReqWs"/"error")`、`FORWARDED_HEADERS`/`stripForwardedHeaders`/`dropForwardedOnProxyReq`/`GATEWAY_ORIGIN` 整段搬入。**逐字保留** quirk #2/#3/#4。

- [ ] **Step 3: git mv sidecar.js → index.js，改用抽出的模块**

```bash
git mv src/sidecar.js src/index.js
```
在 `index.js` 顶部 import 两个新模块，删除已搬走的行内定义，改为 `const { isAuthed, requireAuthPage, requireAuthApi } = createAuth({...})` 和 `const { proxy, stripForwardedHeaders } = createReverseProxy({...})`。`app.use` 反代中间件、`server.on("upgrade")` 逻辑保留在 index.js（它们编排 auth+proxy）。

- [ ] **Step 4: 更新入口引用**

`package.json` scripts：`dev`/`start` 的 `src/sidecar.js` → `src/index.js`，`lint` → `node -c src/index.js`。
`start.sh`：`node /app/src/sidecar.js` 和 `node src/sidecar.js` → `src/index.js`（两处）。

- [ ] **Step 5: 跑测试 + 语法 + 冒烟启动**

Run:
```bash
node --test && node -c src/index.js && node -c src/proxy/auth.js && node -c src/proxy/reverse-proxy.js
```
Expected: 全绿。

冒烟（无 config 时应存活并 /health 200）：
```bash
OPENCLAW_STATE_DIR=$(mktemp -d) PORT=8099 node src/index.js &
sleep 2 && curl -sf http://localhost:8099/health && kill %1
```
Expected: `{"ok":true,...}`。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -q -m "refactor: extract proxy/auth and reverse-proxy, rename entry to index.js"
```

---

## Task 6: 清理 Dockerfile / railway.toml / CLAUDE.md，删空 lib

**Files:**
- Modify: `Dockerfile` `CLAUDE.md` `.env.example`
- Delete: `src/lib/`（若已空）、`src/lib/routes/`（若已空）

- [ ] **Step 1: Dockerfile 去掉 tui/node-pty 相关，改入口**

编辑 `Dockerfile`：删除任何 `node-pty` 构建依赖 apt 包（若仅为 node-pty 而装，如 `python3`/`build-essential` 需确认无其它用途再删——保守起见只删注释明确为 node-pty 的行）；把 CMD/entrypoint 里 `src/sidecar.js` 改 `src/index.js`（若 Dockerfile 直接引用）。**保留** 插件预装到 `/opt/openclaw-plugins`（quirk #8）与 `scripts/patch-weixin-access-policy.js`（quirk #10）。

Run: `grep -n "sidecar\|node-pty\|tui" Dockerfile`
Expected: 处理后无 sidecar/tui/node-pty 残留。

- [ ] **Step 2: 删空目录**

```bash
rmdir src/lib/routes 2>/dev/null; rmdir src/lib 2>/dev/null
git add -A
```
若 `git status` 显示 lib 下还有文件，说明有遗漏未搬迁，回到对应 Task 处理。

- [ ] **Step 3: 精简 CLAUDE.md**

更新 `CLAUDE.md`：Overview 改为「v2 精简版，纯 env 驱动，无 setup 向导」；Key Files 段更新为新目录；**保留** Quirks & Gotchas 全部条目（对应 spec 第 4 节不变量），把其中引用 `src/server.js:行号`、`src/sidecar.js` 的位置改为 `src/index.js` / 新模块路径。删除 setup 向导、tui 相关章节。

- [ ] **Step 4: 更新 .env.example**

删除仅 setup 向导用到的变量说明（若有）；确认 `SETUP_PASSWORD`（现仅用于 /login）说明更新为「保护 Control UI 登录」。

- [ ] **Step 5: 语法/测试回归**

Run: `node --test && node -c src/index.js`
Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -q -m "chore: clean Dockerfile/CLAUDE.md/env for v2, drop empty lib dirs"
```

---

## Task 7: 集成验收 —— 与 v1 行为等价

**Files:**
- 无新增，验证性任务

- [ ] **Step 1: Docker 构建**

```bash
cd /Users/luopeng/vue/openclaw-template-v2
docker build -t openclaw-template-v2 .
```
Expected: 构建成功。

- [ ] **Step 2: 用一组 env 起容器，验证核心对外行为**

```bash
docker run --rm -d --name octv2 -p 8080:8080 \
  -e PORT=8080 -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -e CLAWROUTERS_API_KEY=cr_dummy \
  -e TELEGRAM_BOT_TOKEN=dummy \
  -v $(pwd)/.tmpdata:/data openclaw-template-v2
sleep 10
curl -sf http://localhost:8080/health          # 期望 200 {"ok":true,...}
curl -s http://localhost:8080/login | head -c 100   # 期望登录页 HTML
docker logs octv2 | grep -E "\[sidecar\]|\[gateway\]|\[heartbeat\]"
docker rm -f octv2
```
Expected: `/health` 200；日志出现 gateway 启动 + heartbeat（若配了 ONECLAW_INSTANCE_ID）。

- [ ] **Step 3: openclaw.json 等价性 diff（v1 vs v2）**

分别用同一组 env 在 v1、v2 容器内生成 `openclaw.json`，取出对比：
```bash
# v2 已在 Step 2 的 .tmpdata 里生成
cp .tmpdata/.openclaw/openclaw.json /tmp/v2-openclaw.json
# v1 同样跑一次（在 ../openclaw-template 用相同 env + 相同挂载）后取出为 /tmp/v1-openclaw.json
diff <(jq -S . /tmp/v1-openclaw.json) <(jq -S . /tmp/v2-openclaw.json)
```
Expected: 无差异，或差异仅为已知移除项（无 setup/tui 相关）。有非预期差异则回查对应 config 模块。

- [ ] **Step 4: 逐条核对 spec 第 4 节 12 条不变量**

对照 `docs/superpowers/specs/2026-07-03-openclaw-template-v2-refactor-design.md` 第 4 节，逐条在代码中确认仍存在（token 持久化、proxyReq/proxyReqWs 注入、strip forwarded、allowInsecureAuth、per-client WS、intentionalStop 自愈、plugins.load.paths、config set --json、微信补丁、QR 两路径、runtime defaults）。任一缺失即为回归，补回。

- [ ] **Step 5: 最终提交 + 打 tag**

```bash
git add -A && git commit -q -m "test: verify v2 behavior parity with v1" --allow-empty
git tag v2.0.0-refactor
```

---

## Self-Review 记录

- **Spec 覆盖**：第 3 节对接契约→Task 7 Step 4 核验 + 全程测试保留；第 4 节不变量→Task 5 逐字搬迁 + Task 7 Step 4 逐条核对；第 6 节目录→Task 2/3/4/5；删减项（setup/tui/server/node-pty）→Task 1；配置合并→Task 3；repair 拆分→Task 4；skills 保留→Task 2 直搬。全部有对应任务。
- **占位符**：无 TBD/TODO；每步给出确切命令与期望输出。
- **类型/签名一致**：`createRepairRouter(deps)`、`createAuth({...})`、`createReverseProxy({...})`、`applyRuntimeDefaults`/`generateConfigDirect` 对外名跨任务保持一致，未改调用方签名。
- **已知风险**：Dockerfile 中 python3/build-essential 是否可随 node-pty 一并删除需 Task 6 Step 1 实地确认（保守不删）；auto-config 与 direct-config 分支差异需 Task 3 Step 1 diff 确认。
