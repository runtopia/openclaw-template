# OpenClaw Railway 模板（一键部署）

这个项目将 **OpenClaw** 打包到 Railway，提供一个小型的 **/setup** Web 向导，让用户可以在**不运行任何命令**的情况下完成部署和启动。

## 🎯 你能得到什么

- **OpenClaw 网关 + Control UI** (在 `/` 和 `/openclaw` 提供)
- 友好的**配置向导**在 `/setup` (受密码保护)
- 可选的**Web 终端** (Web TUI) 在 `/tui` 用于浏览器终端访问
- **持久化存储**通过 Railway Volume（配置、凭证、记忆在重新部署时保留）

## ⚙️ 工作原理

- 容器运行一个包装器 Web 服务器
- 包装器用 `SETUP_PASSWORD` 保护 `/setup`
- 初始化设置期间，包装器运行 `openclaw onboard --non-interactive ...`，将状态写入卷存储，然后启动网关
- 设置完成后，**`/` 就是 OpenClaw**。包装器反向代理所有流量（包括 WebSocket）到本地网关进程

## 🚀 快速开始

### 本地开发

```bash
npm install              # 安装依赖
npm run dev             # 开发模式运行（需要 OpenClaw 全局安装或设置 OPENCLAW_ENTRY）
npm start               # 生产环境运行
npm run lint            # 语法检查
```

### Docker 本地测试

```bash
# 构建镜像
docker build -t openclaw-railway-template .

# 运行容器
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e ENABLE_WEB_TUI=true \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template

# 访问
# 配置向导: http://localhost:8080/setup (密码: test)
# Web 终端: http://localhost:8080/tui (设置完成后)
```

## 📝 获取聊天机器人 Token

### Telegram 机器人 Token

1. 在 Telegram 中消息 **@BotFather**
2. 运行 `/newbot` 并按照提示操作
3. BotFather 会给你一个 token，格式如：`123456789:AA...`
4. 粘贴到 `/setup`

### Discord 机器人 Token

1. 打开 Discord 开发者门户：https://discord.com/developers/applications
2. **New Application** → 选择名称
3. 打开 **Bot** 标签 → **Add Bot**
4. 复制 **Bot Token** 粘贴到 `/setup`
5. 邀请机器人到你的服务器（OAuth2 URL Generator → scopes: `bot`、`applications.commands`）

## 💻 Web 终端 (TUI)

模板包含一个可选的基于 Web 的终端，可以在浏览器中运行 `openclaw tui`。

### 启用方式

在 Railway 变量中设置 `ENABLE_WEB_TUI=true`。Web 终端**默认禁用**。

启用后，通过 `/tui` 访问，或点击设置页面的 "Open Terminal" 按钮。

### 安全机制

| 控制项 | 说明 |
|------|------|
| **选择启用** | 默认禁用，需要明确设置 `ENABLE_WEB_TUI=true` |
| **密码保护** | 使用与配置向导相同的 `SETUP_PASSWORD` |
| **单会话** | 一次仅允许 1 个并发 TUI 会话 |
| **空闲超时** | 无活动 5 分钟后自动关闭（可通过 `TUI_IDLE_TIMEOUT_MS` 配置） |
| **最大时长** | 每个会话硬性限制 30 分钟（可通过 `TUI_MAX_SESSION_MS` 配置） |

### TUI 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ENABLE_WEB_TUI` | `false` | 设置为 `true` 启用 |
| `TUI_IDLE_TIMEOUT_MS` | `300000` (5 分钟) | 无活动关闭时间 |
| `TUI_MAX_SESSION_MS` | `1800000` (30 分钟) | 最大会话时长 |

## 📋 环境变量配置

### 必需

| 变量 | 说明 |
|------|------|
| `SETUP_PASSWORD` | 配置向导的访问密码（Basic Auth） |

### 推荐

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCLAW_STATE_DIR` | `/data/.openclaw` | OpenClaw 配置和凭证存储目录 |
| `OPENCLAW_WORKSPACE_DIR` | `/data/workspace` | OpenClaw 工作空间目录 |
| `PORT` | `8080` | 包装器 HTTP 服务器端口 |
| `INTERNAL_GATEWAY_PORT` | `18789` | OpenClaw 网关内部端口 |

### 可选 - OneClaw 集成

| 变量 | 说明 |
|------|------|
| `ONECLAW_API_URL` | OneClaw API 端点 (默认: `https://www.oneclaw.net/api`) |
| `ONECLAW_INSTANCE_ID` | OneClaw 实例 ID |
| `ONECLAW_INSTANCE_SECRET` | OneClaw 实例密钥 |
| `ONECLAW_TEMPLATE_ID` | OneClaw 模板 ID（可选） |

### 可选 - 其他

| 变量 | 说明 |
|------|------|
| `OPENCLAW_GATEWAY_TOKEN` | 网关认证 token（不提供时自动生成） |
| `OPENCLAW_ENTRY` | OpenClaw 入口脚本路径 (默认: `/openclaw/dist/entry.js`) |
| `OPENCLAW_NODE` | Node.js 可执行文件 (默认: `node`) |
| `INTERNAL_GATEWAY_HOST` | 网关绑定地址 (默认: `127.0.0.1`) |
| `CR_PROXY_PORT` | ClawRouters 代理端口 (默认: `18791`) |

## 🏗️ 代码架构

### 核心模块

```
src/
├── server.js                          # Express 主程序入口
├── lib/
│   ├── gateway.js                     # 网关生命周期管理
│   ├── auto-config.js                 # 自动配置逻辑
│   ├── channel-manifest.js            # 渠道配置管理
│   ├── oneclaw-integration.js         # OneClaw 平台集成
│   ├── cr-proxy.js                    # ClawRouters 反向代理
│   └── routes/
│       ├── setup.js                   # /setup 路由处理器
│       ├── api.js                     # /setup/api/* API 端点
│       └── tui.js                     # /tui Web 终端路由
└── public/
    ├── setup.html                     # 配置向导 HTML
    ├── setup-app.js                   # 配置向导客户端 JS（原生）
    ├── tui.html                       # Web 终端 HTML
    └── loading.html                   # 加载页面
```

### 请求流程

```
用户请求
  ↓
Express 服务器 (PORT 8080)
  ├─ /setup/* → setupRouter (auth: SETUP_PASSWORD)
  ├─ /setup/api/* → apiRouter (auth: SETUP_PASSWORD)
  ├─ /tui → tuiRouter (auth: SETUP_PASSWORD)
  ├─ /openclaw → gateway 反向代理 (Token 自动注入)
  └─ 其他 → gateway 反向代理 (Token 自动注入)
```

### 生命周期

#### 1. 未配置状态
- `openclaw.json` 不存在
- 所有非 `/setup` 路由重定向到 `/setup`
- 用户完成配置后自动运行 `openclaw onboard`

#### 2. 配置完成状态
- `openclaw.json` 存在且有效
- 包装器启动网关子进程：`openclaw gateway run --bind loopback ...`
- 轮询网关健康检查端点确保就绪
- 反向代理所有请求，自动注入 Bearer Token

## 🔐 认证两层机制

### 第一层：Web 界面认证
- **类型**：HTTP Basic Auth
- **保护路由**：`/setup`、`/tui`、API 端点
- **凭证**：`SETUP_PASSWORD` 环境变量
- **实现**：`src/lib/routes/*.js` 中的认证中间件

### 第二层：网关 Token 认证
- **类型**：Bearer Token
- **来源**：`OPENCLAW_GATEWAY_TOKEN` 环境变量（无则自动生成）
- **存储**：`${STATE_DIR}/gateway.token`
- **注入方式**：代理所有请求时自动添加 `Authorization: Bearer <token>` 头
- **实现**：`src/lib/cr-proxy.js` 中的代理事件处理器

## ❓ 常见问题

**Q: 如何访问配置页面？**

A: 访问 `/setup` 在你部署的实例。当提示认证时，使用你 Railway 变量中的 `SETUP_PASSWORD` 作为密码。用户名可以留空。

**Q: 看到 "gateway disconnected" 或认证错误怎么办？**

A: 回到 `/setup` 点击 "Open OpenClaw UI" 按钮。设置页面会传递必要的 token 给 UI。直接访问 UI 而不通过设置页面会导致连接错误。

**Q: 在设置页面看不到 TUI 选项。**

A: 确保 `ENABLE_WEB_TUI=true` 已在 Railway 变量中设置并重新部署。Web 终端默认禁用。

**Q: 如何批准 Telegram 或 Discord 的配对请求？**

A: 回到 `/setup` 使用 "Approve Pairing" 对话框批准来自聊天频道的挂起配对请求。

**Q: 设置后如何更换 AI 模型？**

A: 使用 OpenClaw CLI 切换模型。通过 `/tui`（如启用）访问 Web 终端，或 SSH 进入容器运行：

```bash
openclaw models set provider/model-id
```

例如：`openclaw models set anthropic/claude-sonnet-4-20250514` 或 `openclaw models set openai/gpt-4-turbo`。

使用 `openclaw models list --all` 查看可用模型。

**Q: 我的配置出错或遇到奇怪的错误。**

A: 回到 `/setup` 点击 "Run Doctor" 按钮。这会运行 `openclaw doctor --repair`，执行网关和频道的健康检查，备份你的配置，并删除任何无法识别或损坏的配置键。

## 🚢 Railway 部署

部署前确保：

- ✅ 在 Railway 项目中挂载 `/data` 卷
- ✅ 在 Railway 变量中设置 `SETUP_PASSWORD`
- ✅ 启用公开网络（自动分配 `*.up.railway.app` 域名）
- ✅ Dockerfile 构建会自动安装最新版 OpenClaw

## 🐛 调试

### 查看网关日志

```bash
# 容器日志会直接显示网关输出（stdio: "inherit"）
# 查看关键信息：
# [gateway] starting: node /openclaw/dist/entry.js ...
# [gateway] ready at /openclaw
# [event] sent: heartbeat
```

### 测试配置向导

```bash
# 删除配置重置状态
rm -f ${OPENCLAW_STATE_DIR}/openclaw.json

# 访问设置页面重新配置
curl -u :test http://localhost:8080/setup
```

### 测试代理连接

```bash
# 验证 token 注入（应该成功）
curl http://localhost:8080/

# 验证缺少 token 时失败（应该返回 401）
# 临时禁用代理中的 token 注入后测试
```

## 📚 核心概念

### ClawRouters 代理 (cr-proxy)
如果 `CLAWROUTERS_KEY` 环境变量设置，则启动一个额外的 ClawRouters 反向代理，允许更复杂的路由和负载均衡。

### 自动配置 (auto-config)
如果检测到 AI API Key 环境变量，系统可以自动运行初始配置流程。

### 网关管理 (gateway)
负责：
- 启动 OpenClaw 网关子进程
- 监视网关健康状态（轮询 `/openclaw`、`/`、`/health`）
- 在网关崩溃时重启
- 优雅关闭

### OneClaw 集成 (oneclaw-integration)
可选功能，与 OneClaw 平台集成实现：
- 定期心跳信号
- 使用统计追踪
- 个性化配置应用

---

**最后更新：** 2026-05-14
