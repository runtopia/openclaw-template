# openclaw-template-v2 — 精简重构设计文档

日期：2026-07-03
上游 v1：`/Users/luopeng/vue/openclaw-template`
对接对象：`/Users/luopeng/vue/oneclaw_web`（Next.js SaaS 控制台，经 Railway 按用户 provision 实例）

## 1. 目标与背景

v1 (`openclaw-template`) 是 OpenClaw 的 Railway 部署 wrapper：单容器内一个 Node sidecar 作为 PID1，写配置 → 拉起并托管 openclaw gateway → 反向代理对外 → 向 oneclaw_web 上报心跳/接受指令。功能完整但代码长乱（~5225 行，两个入口并存、三套配置路径、setup 向导等）。

**v2 目标：功能不变的前提下，精简重写、理清结构**，只服务于「对接 oneclaw_web」这一唯一用途。

**唯一功能删减**：去掉 `/setup` 配置向导（改为纯 env 驱动）、去掉 web 终端 `tui`（及 `node-pty` 原生依赖）。其余功能（5 渠道、QR 绑定、repair 修复助手、skills、oneclaw 平台对接）**行为保持不变**。

## 2. 非目标

- 不改变对 oneclaw_web 的任何对接契约（agent API、channel manifest、/repair 与 /skills 路径）。
- 不新增功能（无 LLM 配置修复、无通用 watchdog——这些是早期误解，已废弃）。
- 不改 Railway/Docker 部署形态。

## 3. 对接契约（v2 必须原样保持）

### 3.1 OneClaw 平台 agent API（sidecar → oneclaw_web，Bearer = `ONECLAW_INSTANCE_SECRET`）

| 端点 | 方向 | 用途 |
|---|---|---|
| `POST /agent/heartbeat` | 上报 | status(healthy/starting/unhealthy) + uptime + gatewayReady + platforms{telegram,discord,feishu,whatsapp,wechat}；响应可携带 `commands`（如 `apply_template`）|
| `POST /agent/event` | 上报 | 生命周期事件（instance_started 等）|
| `POST /agent/stats` | 上报 | 累计 messages/tokens/model |
| `GET /agent/personality?instanceId=` | 拉取 | 人格 systemPrompt → 写 `workspace/SOUL.md`；template.memoryFiles → 写 workspace |
| `GET /agent/reminders/due?instanceId=` | 拉取 | 到期提醒 → 通过 gateway `POST /rpc {method:"cron.wake"}` 执行 |
| `POST /agent/reminders/executed` | 上报 | 标记提醒已执行 |
| `GET {apiUrl}/templates?id=` | 拉取 | 按 `ONECLAW_TEMPLATE_ID` 拉模板 soulMd/memoryFiles |

心跳启动延迟 30s，间隔 2h；reminders 轮询 60s。

### 3.2 实例对外 HTTP（oneclaw_web → sidecar，反代前置）

- `/health`、`/healthz` — 无需鉴权，sidecar 存活即 200（Railway healthcheck），不依赖 gateway。
- `/repair/chat` — repair AI 诊断助手（SSE）。
- `/repair/bind-channel`、`/repair/config` 及 `/repair/{whatsapp,wechat}-login/*` — QR 绑定 + 配置操作。
- `/skills*` — 技能管理。
- `/openclaw/*` 及其它 — 反向代理到 gateway（注入 Bearer token）。
- `/login` — cookie 会话登录（保护 Control UI）。

### 3.3 渠道清单耦合

`channels/manifest.js` 与 oneclaw_web `src/lib/channels.ts` **配对**（后者注释明确要求两边同步）。渠道：`telegram`/`discord`（token）、`feishu`（appId+secret）、`whatsapp`/`wechat`（QR）。env 约定：token 类由各自 env（`TELEGRAM_BOT_TOKEN` 等）注入；QR 类由 `WHATSAPP_ENABLED=1`/`WECHAT_ENABLED=1` 启用，运行时扫码绑定。

## 4. 必须保留的不变量（血泪 quirk —— 重写不得丢失）

来源 v1 `CLAUDE.md`。重写时逐条对照验证：

1. **gateway token 跨重部署稳定** → 无 env 时持久化到 `${STATE_DIR}/gateway.token`。
2. **反代 token 注入用 `proxy.on("proxyReq"/"proxyReqWs")` 事件**，不能直接改 `req.headers`（WS 升级会 token_missing/mismatch）。
3. **剥离入站 `X-Forwarded-*`/`Forwarded`/`X-Real-IP`**（Railway edge 注入），否则 gateway 判 `isLocalClient=false` → Control UI 被强制 device pairing。
4. **Origin 改写为 gateway 自身地址**，满足 `gateway.controlUi.allowedOrigins`。
5. **每个前端客户端独立一条 gateway WS 连接**（`proxy.ws`），**不做 ws-hub 多路复用**（openclaw EventFrame 无 target-client，多路复用会破坏 per-client 路由）。sidecar 另持一条 WS 仅供自身 RPC（QR 的 `web.login.start`）。
6. **`gateway.controlUi.allowInsecureAuth=true` + `dangerouslyDisableDeviceAuth=true`** 绕过 pairing。
7. **gateway 崩溃自愈带 `intentionalStop` 标志**：主动 stop/restart/优雅退出置 true 跳过自愈；spawn 时清零。repair 的 restart 必须 `waitReady:false`（非阻塞），否则起不来的 gateway 会冻结 SSE 60s。
8. **插件走 `plugins.load.paths` 指向 `/opt/openclaw-plugins`（在 volume 外）**，不用 `npm install -g`（openclaw 不扫全局 node_modules），不放 volume（会被 mount 遮蔽触发 ~650MB 拷贝）。激活需 `plugins.entries.<id>.enabled=true`。
9. **渠道配置用 `config set --json` / 直接写 config，不用 `channels add`**（跨版本不稳）。
10. **微信 access policy 镜像期打补丁**（`scripts/patch-weixin-access-policy.js` 打进 `@tencent-weixin/openclaw-weixin`），读 `channels.openclaw-weixin.dmPolicy/allowFrom`。
11. **QR 两条独立路径**：WhatsApp 经 gateway WS RPC `web.login.start`→`qrDataUrl`；WeChat 经 CLI `channels login --channel openclaw-weixin` 解析 stdout 的 qrUrl。QR 凭证持久化到 `${STATE_DIR}/credentials/`。
12. **runtime defaults 每次启动 patch**：`applyRuntimeDefaults` 强制 heartbeat + ClawRouters memorySearch（`baseUrl` 用 `/api/v1`，不写 `/embeddings`）。

## 5. 架构（单容器，与 v1 一致）

```
容器 (node:22+, npm i -g openclaw@<pinned> + 预装渠道插件到 /opt/openclaw-plugins)
  └─ start.sh (修权限/降权 gosu) → node src/index.js  (PID1)
       ├─ config: 幂等写 openclaw.json（从 env）
       ├─ GatewayManager: spawn `openclaw gateway run`(:18789 loopback)，崩溃自愈
       ├─ Express(:$PORT): /health · /login · /repair/* · /skills/* · 反代其余→gateway
       ├─ OneclawIntegration: heartbeat/event/stats/personality/reminders
       └─ GatewayRpc: 自持一条 WS（QR web.login.start）
```

## 6. v2 目录结构（重写目标）

```
src/
  index.js               # 唯一入口(PID1)：装配各模块 + Express + 启动/优雅退出
  config/
    generate.js          # 唯一配置生成器（合并 v1 direct-config + auto-config + init-config）
    runtime-defaults.js  # applyRuntimeDefaults
    plugins.js           # 预装插件 load.paths 解析（v1 preinstalled-plugins）
    edit.js              # patchConfig / setIn（v1 openclaw-config.js）
  gateway/
    manager.js           # spawn/自愈/重启（v1 gateway.js）
    rpc.js               # 持久 WS RPC（v1 gateway-rpc.js）
  channels/
    manifest.js          # 与 oneclaw_web channels.ts 配对（v1 channel-manifest.js）
    access-policy.js     # 含微信策略（v1 channel-access-policy.js）
    bindings.js          # v1 channel-bindings.js
    wechat-login.js      # v1 wechat-login.js
  integration/
    oneclaw.js           # v1 oneclaw-integration.js
  proxy/
    reverse-proxy.js     # 反代 + token 注入 + forwarded 剥离（从 sidecar.js 抽出）
    auth.js              # cookie/bearer/token 鉴权（从 sidecar.js 抽出）
  repair/
    router.js            # /repair 装配（v1 routes/repair.js 拆分）
    assistant.js         # AI 诊断聊天
    qr-login.js          # whatsapp + wechat 扫码
    config-ops.js        # bind-channel / config 操作
    ai-key.js            # v1 repair-ai-key.js
  skills/
    router.js            # v1 routes/skills.js（整理）
  public/
    login.html           # 保留
    loading.html         # 保留
```

**删除**：`src/server.js`、`src/init-config.js`、`src/lib/auto-config.js`、`src/lib/routes/setup.js`、`src/lib/routes/tui.js`、`src/lib/control-ui-config.js`（并入 config/generate）、`src/public/setup.html`、`src/public/tui.html`、依赖 `node-pty`。

**根级保留/整理**：`Dockerfile`（去掉 tui/node-pty 构建、保留插件预装 + 微信补丁）、`railway.toml`、`docker-compose.yml`、`start.sh`、`.env.example`、`patches/`、`scripts/patch-weixin-access-policy.js`、`test/`。

## 7. 配置生成合并策略

v1 三条路径（direct-config 被 sidecar 用、auto-config 与 init-config 为遗留/备选、setup.js 自写）合并为单一 `config/generate.js`：输入 env → 产出 `openclaw.json`（gateway.auth.token / bind=loopback / trustedProxies / controlUi 全套 + plugins.load.paths + 渠道 entries + runtime defaults）。幂等：已配置则 patch token/channels/插件/defaults；未配置则全量生成。去掉 setup 分支后逻辑单一化。

## 8. 环境变量（沿用 v1）

`PORT`(8080)、`INTERNAL_GATEWAY_PORT`(18789)、`OPENCLAW_STATE_DIR`(/data/.openclaw)、`OPENCLAW_WORKSPACE_DIR`(/data/workspace)、`OPENCLAW_GATEWAY_TOKEN`(可选，否则持久化生成)、`OPENCLAW_ENTRY`、`SETUP_PASSWORD`(保护 Control UI 登录)、`ONECLAW_API_URL`/`ONECLAW_INSTANCE_ID`/`ONECLAW_INSTANCE_SECRET`/`ONECLAW_TEMPLATE_ID`、各 provider key（`CLAWROUTERS_API_KEY` 等）、渠道 token（`TELEGRAM_BOT_TOKEN`/`DISCORD_BOT_TOKEN`/`FEISHU_APP_ID`+`FEISHU_APP_SECRET`/`WHATSAPP_ENABLED`/`WECHAT_ENABLED`）、`PROXY_TIMEOUT_MS`(600000)。

## 9. 错误处理（沿用 v1 语义）

- gateway 崩溃：指数退避自愈（上限 5，ready 后重置），主动停止不自愈（intentionalStop）。
- 反代到未就绪 gateway：`/openclaw` 返回 loading.html；其它 502 gateway unavailable。
- 无 API key：跳过配置生成，gateway 不启动，`/health` 仍 200。
- repair restart 非阻塞，避免冻结 SSE。

## 10. 测试

复用 v1 `test/`（channel-access-policy、channel-bindings、channel-manifest、gateway-manager、gateway-rpc、wechat-login、clawrouters-base-url、weixin-access-policy-patch、whatsapp-login-route），按新目录调整 import 路径。**验收基线**：v2 对外行为与 v1 一致 —— 对同一组 env，生成的 `openclaw.json` 等价；oneclaw_web 的 heartbeat/QR bind/repair chat/proxy 全部照常。

## 11. 迁移与验证

1. 逐模块搬迁（不重造逻辑，先搬后拆），每搬一块跑对应 test。
2. 对照第 4 节不变量逐条核验。
3. 用 `docker build` + `docker run`（挂 volume + 一组 env）本地起容器，验证：`/health` 200、gateway ready、`/openclaw` 可访问、心跳发出、（whatsapp/wechat）QR 端点返回。
4. 与 v1 生成的 `openclaw.json` diff，确认等价。

## 12. 交付物

`src/`（上述结构）、`Dockerfile`、`railway.toml`、`docker-compose.yml`、`start.sh`、`.env.example`、`patches/`、`scripts/`、`test/`、`README.md`、`CLAUDE.md`（精简版，保留不变量清单）。

## 13. 待实现阶段确认

1. `/skills` 实例侧被 oneclaw_web 哪个页面调用（MaintenanceTab/Marketplace）—— 搬迁时核对路径不变。
2. v1 `auto-config.js`/`init-config.js` 是否还有 direct-config 未覆盖的分支，合并前 diff 确认。
3. openclaw 版本锁定号（v1 当前 `2026.6.11`，v2 是否跟随或升级）。
