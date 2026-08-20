# OpenClaw Railway 模板

将 **OpenClaw**（AI 编程助手平台）部署到 Railway 的单容器方案。配置完全由环境变量驱动，无 Web 配置向导，无 Web 终端。[oneclaw_web](https://www.oneclaw.net) SaaS 控制台负责按用户部署和引导。

## 你能得到什么

- **OpenClaw 网关 + Control UI** 在 `/openclaw`
- **反向代理**（监听 `PORT`），自动注入 Bearer Token
- **持久化存储**通过 Railway Volume（`/data`）— 配置、凭证和记忆在重新部署时保留
- **语义记忆检索**：存在 ClawRouters 子密钥时使用 ClawRouters embeddings
- **OneClaw 联网搜索**：通过 ClawRouters 路由，服务端使用 SearXNG/Tavily 回退
- **修复控制台**在 `/repair/*` — AI 诊断对话、网关重启、WhatsApp/微信扫码绑定
- **健康检查端点** `/health`
- **登录页** `/login`（由 `SETUP_PASSWORD` 保护）
- **与 OneClaw Desktop 同源的常用 skills**：默认启用轻量的 skill 查找和自我改进；文档四件套可在构建时开启

Docker 默认使用轻量 `cloud` profile：保留 Gateway、MCP、summarize、轻量 skills
和全部渠道插件，不安装 ClawHub 独立 CLI、浏览器系统库、文档/OCR 运行时、
本地 Agent CLI 与冷门 Go skill 工具。需要 PDF/XLSX/DOCX/PPTX 时使用
`--build-arg ONECLAW_DOCUMENT_SKILLS=1`；完整工具链使用
`--build-arg ONECLAW_RUNTIME_PROFILE=full`。

每位已配置员工生成的媒体仍按 workspace 隔离。镜像会对 OpenClaw 应用一个
fail-closed 补丁：已鉴权的 `assistant-media` 请求可以指定已配置的 `agentId`，
OpenClaw 只加入该员工声明的 workspace 根目录，不会开放任意本地路径。

## 架构

```
用户请求
  ↓
Wrapper（Express 监听 PORT）
  ├─ /health         → 存活检测
  ├─ /login          → Control UI 登录页（鉴权：SETUP_PASSWORD）
  ├─ /repair/*       → 修复助手（session 或 Bearer；runtime input 仅接受实例 Bearer）
  └─ 其他所有路由    → 反向代理到 openclaw gateway（自动注入 Bearer Token）
```

### 生命周期

1. **启动**：Wrapper 读取环境变量并监听端口 → 在 750ms 上限内预取 OneClaw 人格 → 将已有 Agent 的身份、SOUL 和 memory 幂等预写入配置/工作区 → 启动 `openclaw gateway`。Gateway 启动时已带最终人格，不再在 Ready 后执行交互式 setup 或重复文件 RPC。
2. **运行时**：Agent、模型、Key、渠道和绑定配置由 OpenClaw 热加载，不重启 Gateway；仅显式“重启”操作会重启。网关异常退出时自动恢复（指数退避，最多 5 次）。
3. **修复**：`/repair/*` 端点供 oneclaw_web 面板（或直接 API 调用）使用，支持 AI 诊断、网关重启，以及 WhatsApp/微信 QR 绑定流程。

### 默认记忆与联网搜索

配置 `CLAWROUTERS_API_KEY` 后，新实例和已有持久化实例都会在每次启动时收敛到同一套默认能力：

- `agents.defaults.memorySearch` 通过 ClawRouters embeddings 检索记忆文件和历史会话；索引与源文件仍保存在实例自己的 Volume。
- `tools.web.search` 默认选择镜像内置的 `oneclaw-search` provider，复用用户 child key 调用 ClawRouters `/api/v1/search`；SearXNG/Tavily 密钥、缓存、故障回退和积分计费均留在服务端。
- 用户显式选择的其他搜索 provider 或 `enabled=false` 关闭状态不会被覆盖。

### 原生编排与结构化输入

员工和员工团直接使用 OpenClaw 原生 Agent Session、`sessions_spawn`、
`sessions_yield`、子 Session 历史、后台任务、Workboard 和结构化
`update_plan` 工具。已退役的 `oneclaw-workflows` 与
`oneclaw-employee-catalog` 插件不再安装，启动时还会从持久化配置中清理旧注册。
结构化提问与外部应用授权直接发布为 OneClaw Channel Attention 事件，客户端
通过 Channel 控制命令回复，不存在第二套交互服务或 repair 接口。

## 环境变量

### 必需

| 变量 | 说明 |
|------|------|
| `SETUP_PASSWORD` | 保护 `/login` 登录页。不填则无密码直接放行。 |

触发自动配置至少需要一个模型 provider 密钥：

| 变量 | 说明 |
|------|------|
| `CLAWROUTERS_API_KEY` | ClawRouters 多模型路由（推荐） |
| `ANTHROPIC_API_KEY` | Anthropic Claude 直连 |
| `OPENAI_API_KEY` | OpenAI 直连 |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Gemini 直连 |
| `DEEPSEEK_API_KEY` | DeepSeek 直连 |
| `OPENROUTER_API_KEY` | OpenRouter |

OpenAI 直连 provider 默认使用 OpenClaw 内置 agent runtime，与 OneClaw Desktop
保持一致。已有的显式 `agentRuntime` 选择不会被覆盖；默认 pin 可避免云端首启时
额外下载数 GB 的 Codex harness。

### 推荐

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8080` | Wrapper HTTP 端口 |
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | 配置和凭证存储目录 |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | Agent 工作空间目录 |

### 渠道配置

| 变量 | 说明 |
|------|------|
| `TELEGRAM_BOT_TOKEN` | Telegram 机器人 Token |
| `DISCORD_BOT_TOKEN` | Discord 机器人 Token（需在开发者门户开启 MESSAGE CONTENT INTENT） |
| `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` | Slack 机器人和应用 Token |
| `FEISHU_APP_ID` + `FEISHU_APP_SECRET` | 飞书应用凭证 |
| `WHATSAPP_ENABLED=1` | 启用 WhatsApp 渠道；运行后通过 oneclaw_web 面板完成扫码绑定 |
| `WECHAT_ENABLED=1` | 启用微信渠道；运行后通过 oneclaw_web 面板完成扫码绑定 |

### OneClaw 平台集成

| 变量 | 说明 |
|------|------|
| `ONECLAW_API_URL` | OneClaw API 端点（默认：`https://www.oneclaw.net/api/v1`） |
| `ONECLAW_INSTANCE_ID` | oneclaw_web 分配的实例 ID |
| `ONECLAW_INSTANCE_SECRET` | 心跳上报及平台访问受保护 Runtime 接口的实例密钥 |
| `ONECLAW_TEMPLATE_ID` | 模板 ID（可选） |

### 可选 / 高级

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCLAW_GATEWAY_TOKEN` | 自动生成 | 网关 Bearer Token（不设则自动生成并持久化到 `STATE_DIR/gateway.token`） |
| `INTERNAL_GATEWAY_PORT` | `18789` | 网关内部端口 |
| `OPENCLAW_ENTRY` | `/usr/local/lib/node_modules/openclaw/dist/entry.js` | openclaw `entry.js` 路径 |
| `PROXY_TIMEOUT_MS` | `600000` | 反向代理超时（毫秒） |
| `GATEWAY_CHAT_COMPLETIONS_ENABLED` | 关闭 | 启用 `POST /v1/chat/completions`（同时开启 `/v1/models` 和 `/v1/embeddings`） |
| `GATEWAY_RESPONSES_ENABLED` | 关闭 | 启用 `POST /v1/responses` |
| `ONECLAW_PREINSTALLED_SKILLS_ENABLED` | 开启 | 设为 `false` 可关闭镜像预装的常用 skills |

`ONECLAW_RUNTIME_PROFILE` 和 `ONECLAW_DOCUMENT_SKILLS` 是镜像**构建参数**，不是 Railway 运行时变量。

## 本地 Docker 运行

```bash
# 构建镜像
docker build -t openclaw-railway-template .

# 可选：增加 PDF/XLSX/DOCX/PPTX 运行时
docker build --build-arg ONECLAW_DOCUMENT_SKILLS=1 -t openclaw-railway-template:documents .

# 可选：包含完整本地工具链的镜像
docker build --build-arg ONECLAW_RUNTIME_PROFILE=full -t openclaw-railway-template:full .

# 运行容器
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e CLAWROUTERS_API_KEY=your_key_here \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# 访问
# 健康检查：  http://localhost:8080/health
# 登录页：    http://localhost:8080/login   （密码：test）
# Control UI：http://localhost:8080/openclaw
```

按需追加渠道 Token：

```bash
  -e TELEGRAM_BOT_TOKEN=123456789:AA... \
  -e DISCORD_BOT_TOKEN=your_discord_token \
```

## Railway 部署

1. 在 CI 中构建默认 `cloud` 镜像并推送到 Registry，建议用版本号或 digest 固定版本。
2. Railway Service 选择 **Docker Image** 作为 Source，填写预构建镜像地址；Railway 不再执行项目构建。
3. 在 `/data` 挂载一个 **Volume**，并设置环境变量。
4. 开启**公开网络**（自动分配 `*.up.railway.app` 域名）并部署。

镜像中已包含 OpenClaw、wrapper、渠道插件和所选 skills；容器启动阶段不执行
`npm install`、`pip install`、Go 编译或大目录复制。平台下发的普通配置变更直接热加载。
注意：修改 Railway Variables 本身仍会由 Railway 创建新 Deployment；通过 OneClaw/OpenClaw
运行时接口修改 Agent、模型 Key 或渠道配置则无需重启。

启动日志默认开启 OpenClaw phase-level startup trace。`[boot] wrapper listening`、
`[boot] preloaded ... employee profile(s)`、`startup trace:`、`[sidecar] gateway ready`
和 `[boot] runtime profile ready` 可以分别定位 Wrapper、人格预载、OpenClaw 内部阶段、
Gateway 与平台同步耗时。

部署前检查清单：
- `/data` 已挂载 Volume
- `SETUP_PASSWORD` 已设置（或有意留空以开放访问）
- 至少设置一个 provider API 密钥
- 公开网络已开启

## 目录结构

```
src/
├── index.js               # PID1 入口：写 openclaw.json，启动 gateway，启动 Express
├── config/                # 从 env 生成配置（generate.js, runtime-defaults.js, plugins.js, edit.js）
│   └── direct-config.js   # 核心配置构建：buildHttpEndpoints()，applyRuntimeDefaults()
├── gateway/               # 网关进程管理（manager.js, gateway-rpc.js）
├── channels/              # 渠道配置写入（Telegram/Discord/Slack/飞书/WhatsApp/微信）
├── integration/           # OneClaw 平台集成（心跳、人格同步）
├── proxy/                 # 反向代理与鉴权（proxy.js, auth.js）
├── repair/                # 修复助手路由（assistant.js, config-ops.js, qr-login.js）
├── skills/                # 修复助手 AI 工具定义
└── public/                # 静态页面：login.html，loading.html
start.sh                   # Docker 启动脚本：修复 /data 权限 → gosu 降权 → node src/index.js
Dockerfile                 # cloud/full 两种 profile；插件与常用 skills 固化在 /opt
railway.toml               # Railway 部署配置
docker-compose.yml         # 本地开发 compose
```

## 渠道配置指引

### Telegram

1. 在 Telegram 中消息 **@BotFather**。
2. 运行 `/newbot` 并按提示操作。
3. 复制 Token（格式：`123456789:AA...`）。
4. 在 Railway Variables 中设置 `TELEGRAM_BOT_TOKEN` 并重新部署。

### Discord

1. 打开 [Discord 开发者门户](https://discord.com/developers/applications)。
2. **New Application** → **Bot** 标签 → **Add Bot** → 复制 Token。
3. 在 Privileged Gateway Intents 下开启 **MESSAGE CONTENT INTENT**。
4. 通过 OAuth2 URL Generator 邀请机器人（scopes：`bot`、`applications.commands`）。
5. 在 Railway Variables 中设置 `DISCORD_BOT_TOKEN` 并重新部署。

### 飞书 / Lark

在 Railway Variables 中设置 `FEISHU_APP_ID` 和 `FEISHU_APP_SECRET`。

### WhatsApp

设置 `WHATSAPP_ENABLED=1`，部署后通过 oneclaw_web 面板完成扫码绑定。

### 微信

设置 `WECHAT_ENABLED=1`，部署后通过 oneclaw_web 面板完成扫码绑定。

## 常见问题

**Q：如何访问 Control UI？**

A：访问部署实例的 `/login`，输入 `SETUP_PASSWORD`，然后导航到 `/openclaw`。Wrapper 会自动注入网关 Bearer Token，无需手动配置鉴权。

**Q：Control UI 出现 "gateway disconnected" 或认证错误怎么办？**

A：先访问 `/login` 获取 session，再前往 `/openclaw`。如问题持续，检查容器日志中的网关启动错误，并确认 `OPENCLAW_STATE_DIR` 所在的 Volume 已正确挂载且可写。

**Q：如何诊断或修复问题？**

A：修复助手通过 oneclaw_web 面板访问，面板会调用 `/repair/*` 端点，提供 AI 辅助诊断、网关重启和 WhatsApp/微信 QR 绑定功能。

**Q：如何更换 AI 模型？**

A：设置不同的 provider API 密钥，或使用 `CLAWROUTERS_API_KEY` 进行多模型路由。也可在登录后通过 `/openclaw` 的 Control UI 进行模型配置。

**Q：网关 Bearer Token 如何在重新部署后保持稳定？**

A：如果未设置 `OPENCLAW_GATEWAY_TOKEN`，Wrapper 在首次启动时自动生成 Token 并持久化到 `${OPENCLAW_STATE_DIR}/gateway.token`。只要 `/data` Volume 保持挂载，重新部署后会复用同一 Token。

**Q：为什么插件预装在镜像中而不是运行时安装？**

A：OpenClaw 的插件发现机制不扫描全局 `node_modules`。插件在 Docker 构建阶段安装到 `/opt/openclaw-plugins`，并通过 `openclaw.json` 中的 `plugins.load.paths` 声明。Gateway 启动前，Wrapper 还会把这些不可变包写入 OpenClaw 权威的 `state/openclaw.sqlite` 插件安装索引，避免启动 Doctor 再次下载微信、WhatsApp 等已配置渠道。索引写入成功后才会清理 `/data` 中的重复插件副本和对应 npm project。这样可避免每次启动时的大量文件复制或联网安装，同时确保 `/data` Volume 挂载不会覆盖插件文件。

## 支持

需要帮助？[在 Railway Station 提交支持请求](https://station.railway.com/all-templates/d0880c01-2cc5-462c-8b76-d84c1a203348)
