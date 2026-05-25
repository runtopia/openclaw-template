# 修复 API 设计文档

日期：2026-05-25

## 概述

在 Express wrapper 中直接内嵌修复能力，让用户可以通过外部 Dashboard 诊断和修复 OpenClaw 错误——即使 gateway 已经宕机也能正常使用。提供一组修复工具 REST 端点，以及一个带完整工具调用能力的 SSE 流式聊天端点。

## 目标

- 修复聊天只要容器存活就可用（不依赖 gateway）
- AI 使用容器启动时读入内存的 key（免疫用户后续的配置改动）
- 所有端点复用现有 `SETUP_PASSWORD` 认证
- 纯 API，本项目不新增任何 UI 页面

## 架构

### 新文件：`src/lib/routes/repair.js`

挂载到 `server.js` 的 `/setup` 路由下，自动继承 `requireSetupAuth` 中间件。接收 `repairAiKey`（启动时读入内存的 key + baseUrl）以及已有工具的引用（`runCmd`、`clawArgs`、`restartGateway`、`configFilePath`、`gatewayManager`）。

### 改动：`src/lib/gateway.js`

将 gateway 子进程的 `stdio: "inherit"` 改为 pipe 模式，将 stdout/stderr 输出写入内存 ring buffer（最多 500 行）。对外暴露 `getRecentLogs()`。日志同时继续转发到 `process.stdout`，容器日志行为不变。

### 改动：`src/server.js`

启动阶段（配置文件确认存在后）一次性读取默认 provider key 到内存：

```js
const repairAiKey = readDefaultProviderKey(configFilePath());
```

`readDefaultProviderKey` 从 `openclaw.json` 读取 `agents.defaults.model.primary`，解析出 provider 名，再从 `models.providers.<name>` 取 `{ apiKey, baseUrl, model }`。若配置不存在或 key 无法解析则返回 `null`。此值传入 `createRepairRouter`，之后不再重读。

## API 端点

所有路由均需通过 `requireSetupAuth`（Basic Auth，SETUP_PASSWORD）。

### 修复工具

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/setup/api/repair/status` | gateway 进程状态、uptime、是否就绪 |
| `GET` | `/setup/api/repair/logs?n=100` | 最近 N 条 gateway 日志，默认 100，最大 500 |
| `POST` | `/setup/api/repair/doctor` | 执行 `openclaw doctor --fix --yes`，返回 `{ ok, output }` |
| `POST` | `/setup/api/repair/restart` | 调用 `restartGateway()`，返回 `{ ok }` |
| `PATCH` | `/setup/api/repair/config` | 通过 dot-path 修改 `openclaw.json`，body: `{ patches: { "gateway.auth.token": "..." } }`，敏感字段只写不读 |

> 注：`POST /setup/api/doctor` 已存在保留不动。新增的 `/repair/doctor` 使用 `--fix --yes`（非交互式）。

### 修复聊天

```
POST /setup/api/repair/chat
Content-Type: application/json

{ "messages": [{ "role": "user", "content": "gateway 启动失败，帮我排查" }] }
```

响应：`text/event-stream`（SSE）

#### SSE 事件格式

```
data: {"type":"text","delta":"让我先看看日志…"}

data: {"type":"tool_call","name":"read_logs","input":{"n":50}}

data: {"type":"tool_result","name":"read_logs","output":"[gateway] failed to..."}

data: {"type":"text","delta":"找到问题了，正在修复…"}

data: {"type":"tool_call","name":"run_doctor","input":{}}

data: {"type":"tool_result","name":"run_doctor","output":"exit=0 ..."}

data: {"type":"done"}

data: {"type":"error","message":"..."}
```

#### 执行流程

1. 建立 SSE 连接，设置 `Content-Type: text/event-stream`
2. 带工具定义调用 AI API（OpenAI 兼容接口），开启流式输出
3. 文本 delta → 转发为 `{"type":"text","delta":"..."}`
4. 遇到 tool call → 本地执行 → 发送 `tool_call` + `tool_result` 事件 → 追加结果到 messages → 继续下一轮
5. AI 完成 → 发送 `{"type":"done"}` → 关闭连接
6. 任意错误 → 发送 `{"type":"error","message":"..."}` → 关闭连接

每次请求最多 10 轮 tool call，防止无限循环。

#### AI Key 读取

`repairAiKey` 在容器启动时从 `openclaw.json` 一次性读入内存：
- `agents.defaults.model.primary` → provider 名（如 `clawrouters/auto` → `clawrouters`）
- `models.providers.<name>.{ apiKey, baseUrl }` → 用于所有聊天请求
- 若为 `null`（配置尚未生成），`/repair/chat` 返回 `503 { ok: false, reason: "no_key" }`

## AI 工具清单

| 工具 | 类型 | 说明 |
|------|------|------|
| `get_status` | 只读 | gateway 进程状态、uptime、是否就绪 |
| `read_logs` | 只读 | 从 ring buffer 读取最近日志，参数 `n`（默认 100） |
| `read_config` | 只读 | 读取完整 `openclaw.json`，所有 `apiKey`/`token`/`secret` 值替换为 `"[REDACTED]"` |
| `run_doctor` | 操作 | 执行 `openclaw doctor --fix --yes`，返回退出码和输出 |
| `restart_gateway` | 操作 | 终止并重启 gateway 进程 |
| `patch_config` | 操作 | 通过 dot-path 写入 `openclaw.json`，输入：`{ path: "gateway.auth.token", value: "..." }` |

## 改动文件汇总

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/lib/routes/repair.js` | **新增** | 全部修复端点 + 聊天处理逻辑 |
| `src/lib/gateway.js` | 改动 | stdout/stderr 改为 pipe，写入 ring buffer，暴露 `getRecentLogs()` |
| `src/server.js` | 改动 | 启动时读取 `repairAiKey`，传入 `createRepairRouter` |

## 安全说明

- 所有端点均有 `requireSetupAuth` 保护，与 setup 向导共用同一 SETUP_PASSWORD
- `read_config` 返回前自动脱敏所有敏感字段
- `patch_config` 可写入敏感字段，但不会在响应中回显
- tool call 轮数上限 10 轮，防止失控循环
- `repairAiKey` 仅存于内存，不记录日志，不出现在任何响应中
