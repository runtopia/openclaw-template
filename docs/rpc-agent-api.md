# OpenClaw Gateway RPC — Agent 接口文档

**版本**：OpenClaw 2026.5.26  
**端点**：`POST /rpc`（通过 wrapper 无需额外 token，wrapper 自动注入 Bearer）

```bash
# 基础调用格式
curl -X POST https://your-app.up.railway.app/rpc \
  -H "Content-Type: application/json" \
  -d '{"method":"<method>","params":{...}}'
```

> **idempotencyKey**：`agent` 方法必填，其余方法无此字段。建议用 `crypto.randomUUID()` 生成。

---

## 接口总览

| 方法 | 说明 |
|------|------|
| `agents.list` | 列出所有 agent |
| `agents.create` | 创建新 agent |
| `agents.update` | 更新 agent 配置 |
| `agents.delete` | 删除 agent |
| `agents.files.list` | 列出 agent 工作区文件 |
| `agents.files.get` | 读取 agent 文件内容 |
| `agents.files.set` | 写入 agent 文件 |
| `agent.identity.get` | 获取 agent 身份信息 |
| `agent` | 触发 agent 执行（发送消息） |
| `agent.wait` | 等待 agent 运行完成 |
| `wake` | 轻量触发 agent 接收消息 |

---

## 1. `agents.list` — 列出所有 Agent

### 请求
```json
{
  "method": "agents.list",
  "params": {}
}
```

### 响应
```json
{
  "ok": true,
  "result": {
    "defaultId": "main",
    "mainKey": "main",
    "scope": "per-sender",
    "agents": [
      {
        "id": "main",
        "name": "Assistant",
        "identity": {
          "name": "Assistant",
          "emoji": "🤖",
          "avatar": "/path/to/avatar.png",
          "avatarUrl": "https://..."
        },
        "workspace": "/data/workspace",
        "model": {
          "primary": "clawrouters/auto",
          "fallbacks": ["anthropic/claude-sonnet-4-6"]
        },
        "agentRuntime": {
          "id": "claude-sonnet-4-6",
          "source": "model"
        }
      }
    ]
  }
}
```

| 字段 | 说明 |
|------|------|
| `defaultId` | 默认 agent ID（通常是 `main`） |
| `mainKey` | 主 agent 的 key |
| `scope` | 会话作用域：`per-sender`（每用户独立）或 `global` |
| `agents[].agentRuntime.source` | 模型来源：`env` / `agent` / `defaults` / `model` / `provider` / `implicit` |

---

## 2. `agents.create` — 创建 Agent

### 请求
```json
{
  "method": "agents.create",
  "params": {
    "name": "code-reviewer",
    "workspace": "/data/workspace/code-reviewer",
    "model": "clawrouters/auto",
    "emoji": "🔍",
    "avatar": ""
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 显示名称（非空），自动 normalize 为 agentId |
| `workspace` | string | ✅ | 工作目录绝对路径，自动创建 + 初始化 SOUL.md 等文件 |
| `model` | string | ❌ | 模型 ID，如 `clawrouters/auto`、`anthropic/claude-sonnet-4-6` |
| `emoji` | string | ❌ | Agent 表情符号 |
| `avatar` | string | ❌ | Avatar 路径或 URL |

### 响应
```json
{
  "ok": true,
  "result": {
    "ok": true,
    "agentId": "code-reviewer",
    "name": "code-reviewer",
    "workspace": "/data/workspace/code-reviewer",
    "model": "clawrouters/auto"
  }
}
```

**注意**：
- `agentId` 由 `name` 自动 normalize（转小写、空格变连字符）
- `"main"` 是保留 ID，不可使用
- 同名 agentId 已存在会报错
- 自动初始化 workspace 目录及 SOUL.md、AGENTS.md、IDENTITY.md 等文件

---

## 3. `agents.update` — 更新 Agent

### 请求
```json
{
  "method": "agents.update",
  "params": {
    "agentId": "code-reviewer",
    "name": "Code Reviewer Pro",
    "workspace": "/data/workspace/code-reviewer-v2",
    "model": "anthropic/claude-sonnet-4-6",
    "emoji": "🧑‍💻",
    "avatar": ""
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | ✅ | 目标 agent ID |
| `name` | string | ❌ | 新显示名称 |
| `workspace` | string | ❌ | 新工作目录（会自动初始化） |
| `model` | string | ❌ | 新模型 ID |
| `emoji` | string | ❌ | 新表情符号 |
| `avatar` | string | ❌ | 新 avatar |

### 响应
```json
{
  "ok": true,
  "result": {
    "ok": true,
    "agentId": "code-reviewer"
  }
}
```

---

## 4. `agents.delete` — 删除 Agent

### 请求
```json
{
  "method": "agents.delete",
  "params": {
    "agentId": "code-reviewer",
    "deleteFiles": true
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | ✅ | 目标 agent ID，不能是 `"main"` |
| `deleteFiles` | boolean | ❌ | 是否删除 workspace/agentDir 文件，默认 `true`（移入回收站） |

### 响应
```json
{
  "ok": true,
  "result": {
    "ok": true,
    "agentId": "code-reviewer",
    "removedBindings": 2
  }
}
```

| 字段 | 说明 |
|------|------|
| `removedBindings` | 同时清除的渠道绑定数量 |

---

## 5. `agents.files.list` — 列出 Agent 工作区文件

### 请求
```json
{
  "method": "agents.files.list",
  "params": {
    "agentId": "main"
  }
}
```

### 响应
```json
{
  "ok": true,
  "result": {
    "agentId": "main",
    "workspace": "/data/workspace",
    "files": [
      {
        "name": "SOUL.md",
        "path": "/data/workspace/SOUL.md",
        "missing": false,
        "size": 1024,
        "updatedAtMs": 1748908800000,
        "content": null
      },
      {
        "name": "MEMORY.md",
        "path": "/data/workspace/MEMORY.md",
        "missing": true,
        "size": null,
        "updatedAtMs": null,
        "content": null
      }
    ]
  }
}
```

**常见文件**：`SOUL.md`（system prompt）、`MEMORY.md`（记忆）、`IDENTITY.md`（身份）、`AGENTS.md`、`TOOLS.md`、`HEARTBEAT.md`

---

## 6. `agents.files.get` — 读取 Agent 文件内容

### 请求
```json
{
  "method": "agents.files.get",
  "params": {
    "agentId": "main",
    "name": "SOUL.md"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | ✅ | Agent ID |
| `name` | string | ✅ | 文件名（仅文件名，不含路径） |

### 响应
```json
{
  "ok": true,
  "result": {
    "agentId": "main",
    "workspace": "/data/workspace",
    "file": {
      "name": "SOUL.md",
      "path": "/data/workspace/SOUL.md",
      "missing": false,
      "size": 1024,
      "updatedAtMs": 1748908800000,
      "content": "# System Prompt\n\n你是一个..."
    }
  }
}
```

---

## 7. `agents.files.set` — 写入 Agent 文件

### 请求
```json
{
  "method": "agents.files.set",
  "params": {
    "agentId": "main",
    "name": "SOUL.md",
    "content": "# System Prompt\n\n你是一个专业的代码审查助手..."
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | ✅ | Agent ID |
| `name` | string | ✅ | 文件名 |
| `content` | string | ✅ | 文件完整内容（覆盖写入） |

### 响应
```json
{
  "ok": true,
  "result": {
    "ok": true,
    "agentId": "main",
    "workspace": "/data/workspace",
    "file": {
      "name": "SOUL.md",
      "path": "/data/workspace/SOUL.md",
      "missing": false,
      "size": 512,
      "updatedAtMs": 1748912400000,
      "content": "# System Prompt\n\n你是一个专业的代码审查助手..."
    }
  }
}
```

---

## 8. `agent.identity.get` — 获取 Agent 身份信息

### 请求
```json
{
  "method": "agent.identity.get",
  "params": {
    "agentId": "main",
    "sessionKey": ""
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agentId` | string | ❌ | Agent ID，省略则使用默认 |
| `sessionKey` | string | ❌ | 会话 key（可替代 agentId 推断） |

### 响应
```json
{
  "ok": true,
  "result": {
    "agentId": "main",
    "name": "Assistant",
    "avatar": "https://your-app.up.railway.app/openclaw/agent-avatar/main",
    "avatarSource": "local",
    "avatarStatus": "local",
    "avatarReason": null,
    "emoji": "🤖"
  }
}
```

| `avatarStatus` | 说明 |
|------|------|
| `none` | 无 avatar |
| `local` | 本地文件 |
| `remote` | 远程 URL |
| `data` | data URI |

---

## 9. `agent` — 触发 Agent 执行

向 agent 发送一条消息并启动一次运行，立即返回（不等待执行完成）。

### 请求
```json
{
  "method": "agent",
  "params": {
    "message": "帮我 review 一下这段代码...",
    "idempotencyKey": "550e8400-e29b-41d4-a716-446655440000",
    "agentId": "main",
    "sessionKey": "",
    "sessionId": "",
    "model": "",
    "provider": "",
    "to": "",
    "replyTo": "",
    "channel": "telegram",
    "replyChannel": "",
    "accountId": "",
    "threadId": "",
    "deliver": true,
    "timeout": 60000,
    "promptMode": "full",
    "extraSystemPrompt": "",
    "bootstrapContextMode": "full",
    "bootstrapContextRunKind": "default",
    "label": ""
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `message` | string | ✅ | 发送给 agent 的消息内容 |
| `idempotencyKey` | string | ✅ | 唯一请求 ID（同 key 重复调用返回缓存结果，也作为 runId 使用） |
| `agentId` | string | ❌ | 目标 agent ID，省略用默认 |
| `sessionKey` | string | ❌ | 会话 key，指定继续某个会话 |
| `sessionId` | string | ❌ | 会话 ID |
| `model` | string | ❌ | 覆盖模型（需有 model override 权限） |
| `provider` | string | ❌ | 覆盖 provider |
| `to` | string | ❌ | 回复目标（渠道地址） |
| `replyTo` | string | ❌ | 回复的消息 ID |
| `channel` | string | ❌ | 渠道 ID，如 `telegram`、`discord` |
| `deliver` | boolean | ❌ | 是否通过渠道投递回复 |
| `timeout` | integer | ❌ | 超时毫秒数 |
| `promptMode` | string | ❌ | `full`（完整）/ `minimal` / `none`（纯模型调用） |
| `extraSystemPrompt` | string | ❌ | 附加 system prompt（追加到 SOUL.md 之后） |
| `bootstrapContextMode` | string | ❌ | `full` / `lightweight` |
| `bootstrapContextRunKind` | string | ❌ | `default` / `heartbeat` / `cron` |
| `label` | string | ❌ | 运行标签（用于标识） |
| `bestEffortDeliver` | boolean | ❌ | 投递失败时不报错 |

### 响应（已接受）
```json
{
  "ok": true,
  "result": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "sessionKey": "main:user123:abc",
    "status": "accepted",
    "acceptedAt": 1748912400000
  }
}
```

### 响应（重复请求，命中缓存）
```json
{
  "ok": true,
  "result": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "in_flight",
    "sessionKey": "main:user123:abc"
  }
}
```

**注意**：返回 `accepted` 只代表任务已入队，不代表执行完成。用 `agent.wait` 等待结果。

---

## 10. `agent.wait` — 等待 Agent 运行完成

### 请求
```json
{
  "method": "agent.wait",
  "params": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "timeoutMs": 30000
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `runId` | string | ✅ | `agent` 方法返回的 runId（即 idempotencyKey） |
| `timeoutMs` | integer | ❌ | 等待超时毫秒，默认 `30000`（30s） |

### 响应（完成）
```json
{
  "ok": true,
  "result": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "done",
    "startedAt": 1748912400000,
    "endedAt": 1748912415000,
    "error": null,
    "stopReason": "end_turn",
    "livenessState": null,
    "yielded": false,
    "timeoutPhase": null,
    "providerStarted": true
  }
}
```

### 响应（超时）
```json
{
  "ok": true,
  "result": {
    "runId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "timeout",
    "timeoutPhase": "queue",
    "providerStarted": false
  }
}
```

| `status` | 说明 |
|------|------|
| `done` | 正常完成 |
| `timeout` | 等待超时 |
| `error` | 执行出错 |

| `timeoutPhase` | 说明 |
|------|------|
| `queue` | 任务还在排队时超时 |
| `gateway_draining` | gateway 正在处理时超时 |

---

## 11. `wake` — 轻量触发 Agent 接收消息

比 `agent` 更轻量，专为 cron/提醒场景设计。

### 请求
```json
{
  "method": "wake",
  "params": {
    "mode": "now",
    "text": "现在是早上 9 点，请发送今日天气预报",
    "sessionKey": ""
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | string | ✅ | `"now"`（立即）或 `"next-heartbeat"`（下次心跳时） |
| `text` | string | ✅ | 触发文本内容 |
| `sessionKey` | string | ❌ | 指定会话 key |

---

## 常用组合示例

### 创建并使用新 Agent

```bash
# 1. 创建 agent
curl -X POST https://your-app.up.railway.app/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "agents.create",
    "params": {
      "name": "code-reviewer",
      "workspace": "/data/workspace/code-reviewer",
      "model": "clawrouters/auto",
      "emoji": "🔍"
    }
  }'

# 2. 写入 system prompt
curl -X POST https://your-app.up.railway.app/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "agents.files.set",
    "params": {
      "agentId": "code-reviewer",
      "name": "SOUL.md",
      "content": "你是一个专业的代码审查助手，擅长发现安全漏洞和性能问题。"
    }
  }'

# 3. 向该 agent 发送消息
curl -X POST https://your-app.up.railway.app/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "agent",
    "params": {
      "message": "请审查这段代码：...",
      "agentId": "code-reviewer",
      "idempotencyKey": "run-001",
      "deliver": false
    }
  }'

# 4. 等待结果
curl -X POST https://your-app.up.railway.app/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "agent.wait",
    "params": {
      "runId": "run-001",
      "timeoutMs": 60000
    }
  }'
```

### 读取并更新 Agent System Prompt

```bash
# 读取
curl -X POST https://your-app.up.railway.app/rpc \
  -H "Content-Type: application/json" \
  -d '{"method":"agents.files.get","params":{"agentId":"main","name":"SOUL.md"}}'

# 更新
curl -X POST https://your-app.up.railway.app/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "agents.files.set",
    "params": {
      "agentId": "main",
      "name": "SOUL.md",
      "content": "你是一个专业助手..."
    }
  }'
```

### 定时触发 Agent

```bash
curl -X POST https://your-app.up.railway.app/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "method": "wake",
    "params": {
      "mode": "now",
      "text": "请执行每日报告任务"
    }
  }'
```
