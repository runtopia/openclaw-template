# Repair API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Express wrapper 中内嵌修复 API 和流式聊天端点，让用户在 gateway 宕机时仍能通过 /setup 页面诊断和修复 OpenClaw。

**Architecture:** 新建 `src/lib/routes/repair.js` 挂载到 `/setup` 路由下，复用 `requireSetupAuth`。修改 `gateway.js` 将日志写入内存 ring buffer。服务启动时从 `openclaw.json` 读取默认 provider key 存入内存，之后不再重读。聊天端点通过 SSE 流式返回 AI 回复和工具调用结果。

**Tech Stack:** Node.js ESM, Express, fetch (node built-in), Alpine.js, Tailwind CSS

---

## File Map

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/lib/repair-ai-key.js` | 新增 | 从 openclaw.json 读取默认 provider key |
| `src/lib/routes/repair.js` | 新增 | 全部修复端点 + SSE 聊天 |
| `src/lib/gateway.js` | 改动 | pipe 模式 + ring buffer + `getRecentLogs()` |
| `src/server.js` | 改动 | 启动时读 repairAiKey，挂载 repair 路由 |
| `src/public/setup.html` | 改动 | 修复助手面板 + i18n + Alpine 状态/方法 |

---

## Task 1: Gateway 日志 Ring Buffer

**Files:**
- Modify: `src/lib/gateway.js`

- [ ] **Step 1: 在 `createGatewayManager` 函数顶部添加 ring buffer 数据结构**

在 `src/lib/gateway.js` 的 `createGatewayManager` 函数体最开头（`let gatewayProc = null;` 之前）插入：

```js
const LOG_BUFFER_MAX = 500;
const logBuffer = [];
function appendLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
}
```

- [ ] **Step 2: 将 `startGateway` 里的 `stdio: "inherit"` 改为 pipe 并转发日志**

将 `gateway.js` 中 `startGateway` 函数里的 spawn 调用：

```js
gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
  stdio: "inherit",
  env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WORKSPACE_DIR: workspaceDir },
});
```

替换为：

```js
gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WORKSPACE_DIR: workspaceDir },
});
function handleOutput(chunk) {
  const lines = chunk.toString().split("\n");
  for (const line of lines) {
    if (line) { appendLog(line); process.stdout.write(line + "\n"); }
  }
}
gatewayProc.stdout.on("data", handleOutput);
gatewayProc.stderr.on("data", handleOutput);
```

- [ ] **Step 3: 在 return 对象中暴露 `getRecentLogs`**

在 `createGatewayManager` 末尾的 `return { ... }` 中追加：

```js
getRecentLogs: (n = 100) => logBuffer.slice(-Math.min(n, LOG_BUFFER_MAX)),
```

- [ ] **Step 4: 验证日志仍然输出到容器 stdout**

```bash
node -e "
import('./src/lib/gateway.js').then(m => {
  const gm = m.createGatewayManager({
    OPENCLAW_NODE: 'node', clawArgs: a => a,
    stateDir: '/tmp', workspaceDir: '/tmp',
    internalGatewayPort: 18789, internalGatewayHost: '127.0.0.1',
    gatewayToken: 'test', isConfigured: () => false,
  });
  console.log('getRecentLogs:', typeof gm.getRecentLogs);
});
"
```

Expected: 打印 `getRecentLogs: function`，无报错。

- [ ] **Step 5: Commit**

```bash
git add src/lib/gateway.js
git commit -m "feat(gateway): pipe logs to ring buffer, expose getRecentLogs()"
```

---

## Task 2: repairAiKey 读取 Helper

**Files:**
- Create: `src/lib/repair-ai-key.js`

- [ ] **Step 1: 创建 `src/lib/repair-ai-key.js`**

```js
import fs from "node:fs";

export function readDefaultProviderKey(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const primary = cfg?.agents?.defaults?.model?.primary || "";
    const providerName = primary.includes("/") ? primary.split("/")[0] : primary;
    if (!providerName) return null;
    const provider = cfg?.models?.providers?.[providerName];
    if (!provider?.apiKey) return null;
    return {
      apiKey: provider.apiKey,
      baseUrl: (provider.baseUrl || "https://api.openai.com/v1").replace(/\/$/, ""),
      model: primary,
      providerName,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: 手动验证（用已有的 openclaw.json 或临时文件）**

```bash
node -e "
import('./src/lib/repair-ai-key.js').then(({ readDefaultProviderKey }) => {
  // 测试不存在的路径
  console.log('missing:', readDefaultProviderKey('/tmp/nonexistent.json'));

  // 测试有效配置
  const fs = await import('node:fs');
  fs.writeFileSync('/tmp/test-cfg.json', JSON.stringify({
    agents: { defaults: { model: { primary: 'clawrouters/auto' } } },
    models: { providers: { clawrouters: { apiKey: 'cr-test', baseUrl: 'https://example.com/v1' } } }
  }));
  console.log('valid:', readDefaultProviderKey('/tmp/test-cfg.json'));
});
"
```

Expected 输出：
```
missing: null
valid: { apiKey: 'cr-test', baseUrl: 'https://example.com/v1', model: 'clawrouters/auto', providerName: 'clawrouters' }
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/repair-ai-key.js
git commit -m "feat(repair): add readDefaultProviderKey helper"
```

---

## Task 3: Repair 工具端点

**Files:**
- Create: `src/lib/routes/repair.js`（仅工具端点，聊天在 Task 4 添加）

- [ ] **Step 1: 创建 `src/lib/routes/repair.js` 包含 5 个工具端点**

```js
import express from "express";
import fs from "node:fs";
import { patchConfig, setIn } from "../openclaw-config.js";

const SENSITIVE_KEYS = new Set(["apiKey", "token", "secret", "password", "key"]);

function redactConfig(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(redactConfig);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const isSensitive = SENSITIVE_KEYS.has(k) ||
      k.toLowerCase().includes("token") ||
      k.toLowerCase().includes("secret") ||
      k.toLowerCase().includes("apikey");
    out[k] = (isSensitive && typeof v === "string" && v) ? "[REDACTED]" : redactConfig(v);
  }
  return out;
}

export function createRepairRouter({
  requireSetupAuth,
  runCmd,
  clawArgs,
  OPENCLAW_NODE,
  restartGateway,
  configFilePath,
  gatewayManager,
  repairAiKey,
}) {
  const router = express.Router();

  // GET /setup/api/repair/status
  router.get("/status", requireSetupAuth, (req, res) => {
    res.json({
      ok: true,
      gatewayReady: gatewayManager.isGatewayReady(),
      gatewayStarting: gatewayManager.isGatewayStarting(),
      uptime: process.uptime(),
      repairChatAvailable: repairAiKey !== null,
    });
  });

  // GET /setup/api/repair/logs?n=100
  router.get("/logs", requireSetupAuth, (req, res) => {
    const n = Math.min(parseInt(req.query.n || "100", 10) || 100, 500);
    const lines = gatewayManager.getRecentLogs(n);
    res.json({ ok: true, lines });
  });

  // POST /setup/api/repair/doctor
  router.post("/doctor", requireSetupAuth, async (_req, res) => {
    try {
      const result = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix", "--yes"]));
      res.json({ ok: result.code === 0, output: result.output });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // POST /setup/api/repair/restart
  router.post("/restart", requireSetupAuth, async (_req, res) => {
    try {
      await restartGateway();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // PATCH /setup/api/repair/config
  router.patch("/config", requireSetupAuth, (req, res) => {
    const { patches } = req.body || {};
    if (!patches || typeof patches !== "object" || Array.isArray(patches)) {
      return res.status(400).json({ ok: false, error: "patches must be an object" });
    }
    try {
      patchConfig(configFilePath(), (cfg) => {
        for (const [dotPath, value] of Object.entries(patches)) {
          setIn(cfg, dotPath, value);
        }
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // GET /setup/api/repair/config (read-only, redacted)
  router.get("/config", requireSetupAuth, (req, res) => {
    try {
      const cfgPath = configFilePath();
      if (!fs.existsSync(cfgPath)) return res.json({ ok: true, config: null });
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      res.json({ ok: true, config: redactConfig(raw) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  return router;
}
```

- [ ] **Step 2: 验证模块可以加载（语法检查）**

```bash
node --input-type=module <<'EOF'
import { createRepairRouter } from './src/lib/routes/repair.js';
console.log('ok:', typeof createRepairRouter);
EOF
```

Expected: `ok: function`

- [ ] **Step 3: Commit**

```bash
git add src/lib/routes/repair.js
git commit -m "feat(repair): add repair tool endpoints (status/logs/doctor/restart/config)"
```

---

## Task 4: Repair 聊天 SSE 端点

**Files:**
- Modify: `src/lib/routes/repair.js`

- [ ] **Step 1: 在 repair.js 的 `createRepairRouter` 中添加工具定义常量**

在 `export function createRepairRouter` 函数体内，router 声明之前插入：

```js
const REPAIR_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_status",
      description: "获取 gateway 进程状态、uptime 和是否就绪",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_logs",
      description: "从内存 ring buffer 读取最近的 gateway 日志行",
      parameters: {
        type: "object",
        properties: { n: { type: "number", description: "返回行数，默认 100，最大 500" } },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_config",
      description: "读取 openclaw.json 配置（敏感字段已脱敏）",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "run_doctor",
      description: "执行 openclaw doctor --fix --yes 修复配置",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "restart_gateway",
      description: "终止并重启 gateway 进程",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "patch_config",
      description: "通过 dot-path 写入 openclaw.json 的指定字段",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "dot-path，如 gateway.auth.token" },
          value: { description: "要写入的值" },
        },
        required: ["path", "value"],
      },
    },
  },
];
```

- [ ] **Step 2: 添加工具执行函数**

在 `REPAIR_TOOLS` 常量之后、router 声明之前插入：

```js
async function executeTool(name, args, { gatewayManager, runCmd, OPENCLAW_NODE, clawArgs, configFilePath }) {
  switch (name) {
    case "get_status":
      return JSON.stringify({
        gatewayReady: gatewayManager.isGatewayReady(),
        gatewayStarting: gatewayManager.isGatewayStarting(),
        uptime: process.uptime(),
      });
    case "read_logs": {
      const n = Math.min(parseInt(args?.n || "100", 10) || 100, 500);
      return gatewayManager.getRecentLogs(n).join("\n") || "(no logs yet)";
    }
    case "read_config": {
      const cfgPath = configFilePath();
      if (!fs.existsSync(cfgPath)) return "(config file not found)";
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      return JSON.stringify(redactConfig(raw), null, 2);
    }
    case "run_doctor": {
      const r = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix", "--yes"]));
      return `exit=${r.code}\n${r.output}`;
    }
    case "restart_gateway":
      await restartGateway();
      return "gateway restart initiated";
    case "patch_config": {
      patchConfig(configFilePath(), (cfg) => setIn(cfg, args.path, args.value));
      return `patched ${args.path}`;
    }
    default:
      return `unknown tool: ${name}`;
  }
}
```

- [ ] **Step 3: 添加 SSE 聊天端点**

在工具端点之后、`return router;` 之前插入：

```js
// POST /setup/api/repair/chat
router.post("/chat", requireSetupAuth, async (req, res) => {
  if (!repairAiKey) {
    return res.status(503).json({ ok: false, reason: "no_key" });
  }

  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ ok: false, error: "messages array required" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  function emit(obj) {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  const toolCtx = { gatewayManager, runCmd, OPENCLAW_NODE, clawArgs, configFilePath };
  const history = [
    { role: "system", content: "你是 OpenClaw 修复助手。诊断并修复 gateway 配置和运行问题。使用工具获取信息再采取行动，解释你的每一步操作。" },
    ...messages,
  ];

  const MAX_ROUNDS = 10;
  let round = 0;

  try {
    while (round < MAX_ROUNDS) {
      round++;
      const aiRes = await fetch(`${repairAiKey.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${repairAiKey.apiKey}`,
        },
        body: JSON.stringify({
          model: repairAiKey.model || "auto",
          messages: history,
          tools: REPAIR_TOOLS,
          tool_choice: "auto",
        }),
      });

      if (!aiRes.ok) {
        const errText = await aiRes.text();
        emit({ type: "error", message: `AI API error ${aiRes.status}: ${errText}` });
        break;
      }

      const data = await aiRes.json();
      const choice = data.choices?.[0];
      if (!choice) { emit({ type: "error", message: "empty response from AI" }); break; }

      const msg = choice.message;
      history.push(msg);

      if (msg.content) emit({ type: "text", delta: msg.content });

      if (choice.finish_reason === "tool_calls" && msg.tool_calls?.length) {
        const toolResults = [];
        for (const tc of msg.tool_calls) {
          const toolName = tc.function.name;
          let args = {};
          try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
          emit({ type: "tool_call", id: tc.id, name: toolName, input: args });
          const output = await executeTool(toolName, args, toolCtx);
          emit({ type: "tool_result", id: tc.id, name: toolName, output });
          toolResults.push({ role: "tool", tool_call_id: tc.id, content: output });
        }
        history.push(...toolResults);
        continue;
      }

      break;
    }

    if (round >= MAX_ROUNDS) emit({ type: "error", message: "reached max tool call rounds (10)" });
    emit({ type: "done" });
  } catch (err) {
    emit({ type: "error", message: String(err) });
  } finally {
    res.end();
  }
});
```

- [ ] **Step 4: 验证模块加载无报错**

```bash
node --input-type=module <<'EOF'
import { createRepairRouter } from './src/lib/routes/repair.js';
console.log('ok:', typeof createRepairRouter);
EOF
```

Expected: `ok: function`

- [ ] **Step 5: Commit**

```bash
git add src/lib/routes/repair.js
git commit -m "feat(repair): add SSE chat endpoint with tool use"
```

---

## Task 5: server.js 接入

**Files:**
- Modify: `src/server.js`

- [ ] **Step 1: 在 server.js 顶部 import 区添加两行**

在现有 `import { createTuiRouter }` 那行之后追加：

```js
import { createRepairRouter } from "./lib/routes/repair.js";
import { readDefaultProviderKey } from "./lib/repair-ai-key.js";
```

- [ ] **Step 2: 在 `requireSetupAuth` 中间件定义之后，Express app 初始化之前读取 repairAiKey**

找到 `src/server.js` 中 `const app = express();` 这行，在其之前插入：

```js
// 启动时一次性读取 repair 聊天所需的 AI key（之后不再重读）
const repairAiKey = readDefaultProviderKey(configFilePath());
if (repairAiKey) {
  console.log(`[repair] AI key loaded for provider: ${repairAiKey.providerName}`);
} else {
  console.log("[repair] no AI key found in config — chat endpoint will return 503");
}
```

- [ ] **Step 3: 找到 `app.use("/setup", setupRouter);` 这行，在其之后挂载 repair 路由**

```js
// Repair API (挂载在 /setup/api/repair/*)
const repairRouter = createRepairRouter({
  requireSetupAuth,
  runCmd,
  clawArgs,
  OPENCLAW_NODE,
  restartGateway: gateway.restartGateway,
  configFilePath,
  gatewayManager: gateway,
  repairAiKey,
});
app.use("/setup/api/repair", repairRouter);
```

> 注意：repair 路由在 setup 路由之后单独挂载到 `/setup/api/repair`，不嵌套在 setupRouter 内部（setupRouter 内部已有自己的 `requireSetupAuth`，这里需要将其作为参数传入 repair router）。

- [ ] **Step 4: 找到 server.js 中 `requireSetupAuth` 函数定义，确认它被正确传递**

在 `server.js` 中搜索 `requireSetupAuth` 的定义位置：

```bash
grep -n "function requireSetupAuth\|const requireSetupAuth" src/server.js
```

如果 `requireSetupAuth` 定义在 `createSetupRouter` 内部（`setup.js` 里），则需要从 `setup.js` 导出它，或者在 `server.js` 里单独定义一份。

检查 `src/lib/routes/setup.js` 中 `requireSetupAuth` 的定义位置：

```bash
grep -n "requireSetupAuth" src/lib/routes/setup.js | head -10
```

如果定义在 `createSetupRouter` 内部，将其提取为独立导出函数，在 `setup.js` 中添加：

```js
export function createRequireSetupAuth(SETUP_PASSWORD) {
  return function requireSetupAuth(req, res, next) {
    // 将 createSetupRouter 内部的 requireSetupAuth 函数体复制到这里
    // （或重构 createSetupRouter 使用此函数）
  };
}
```

然后在 `server.js` import 中追加：

```js
import { createSetupRouter, createRequireSetupAuth } from "./lib/routes/setup.js";
```

并在 repair router 初始化之前：

```js
const requireSetupAuth = createRequireSetupAuth(SETUP_PASSWORD);
```

- [ ] **Step 5: 启动服务器验证端点可达**

```bash
node src/server.js &
sleep 2
# 无密码应该 401
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/setup/api/repair/status
# 有密码应该 200（SETUP_PASSWORD=test 时）
curl -s -u ":test" http://localhost:8080/setup/api/repair/status
```

Expected: 第一个返回 `401`，第二个返回 `{"ok":true,...}`

```bash
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add src/server.js src/lib/routes/setup.js
git commit -m "feat(repair): wire repair router into server.js"
```

---

## Task 6: setup.html 修复助手面板

**Files:**
- Modify: `src/public/setup.html`

- [ ] **Step 1: 在 I18N 对象的 `en` 分支末尾追加修复助手词条**

找到 `en` 分支里最后一个词条（如 `doctorFoundIssues: 'Doctor found issues'`），在其后追加（`,` 隔开）：

```js
repairTitle: 'Repair Assistant',
repairDesc: 'AI-powered assistant to diagnose and fix OpenClaw issues. Works even when the gateway is down.',
repairPlaceholder: 'Describe the issue, e.g. "gateway won\'t start, help me fix it"',
repairSend: 'Send',
repairSending: 'Thinking...',
repairRestart: 'Restart Gateway',
repairViewLogs: 'View Logs',
repairNoKey: 'No AI key available — chat is offline. Repair tools still work.',
repairToolCall: '🔧',
repairExpand: 'Show result',
repairCollapse: 'Hide result',
```

在 `zh` 分支末尾同样追加：

```js
repairTitle: '修复助手',
repairDesc: 'AI 驱动的修复助手，可诊断并修复 OpenClaw 问题。即使 gateway 宕机也可使用。',
repairPlaceholder: '描述问题，例如"gateway 启动失败，帮我排查"',
repairSend: '发送',
repairSending: '思考中...',
repairRestart: '重启 Gateway',
repairViewLogs: '查看日志',
repairNoKey: '没有可用的 AI Key，聊天功能离线。修复工具仍然可用。',
repairToolCall: '🔧',
repairExpand: '展开结果',
repairCollapse: '收起结果',
```

- [ ] **Step 2: 在 Alpine.js `setupApp()` 数据对象中追加 repair 状态**

找到 `tuiEnabled: false,` 这一行，在其后追加（`,` 隔开）：

```js
repairMessages: [],
repairInput: '',
repairSending: false,
repairChatAvailable: false,
repairLogs: '',
repairShowLogs: false,
```

- [ ] **Step 3: 在 `refreshStatus()` 方法里读取 repairChatAvailable**

找到 `this.isReady = true;`（在 try 块里的那行），在其之前插入：

```js
// 查询 repair 状态
try {
  const rj = await this.httpJson('/setup/api/repair/status');
  this.repairChatAvailable = rj.repairChatAvailable || false;
} catch {}
```

- [ ] **Step 4: 在 Alpine.js `setupApp()` 数据对象中追加 repair 方法**

找到最后一个方法（如 `async runDoctor() { ... }`），在其后追加：

```js
async sendRepairMessage() {
  if (!this.repairInput.trim() || this.repairSending) return;
  const userMsg = { role: 'user', content: this.repairInput.trim() };
  this.repairMessages.push({ ...userMsg, _type: 'user' });
  this.repairInput = '';
  this.repairSending = true;

  // 收集非系统消息历史
  const history = this.repairMessages
    .filter(m => m._type === 'user' || m._type === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const aiMsg = { role: 'assistant', content: '', _type: 'assistant', _toolCalls: [] };
  this.repairMessages.push(aiMsg);

  try {
    const res = await fetch('/setup/api/repair/chat', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue;
        try {
          const ev = JSON.parse(part.slice(6));
          if (ev.type === 'text') {
            aiMsg.content += ev.delta;
          } else if (ev.type === 'tool_call') {
            aiMsg._toolCalls.push({ ...ev, _output: null, _expanded: false });
          } else if (ev.type === 'tool_result') {
            const tc = aiMsg._toolCalls.find(t => t.id === ev.id);
            if (tc) tc._output = ev.output;
          } else if (ev.type === 'error') {
            aiMsg.content += '\n\n❌ ' + ev.message;
          }
          // 触发 Alpine reactivity
          this.repairMessages = [...this.repairMessages];
        } catch {}
      }
    }
  } catch (err) {
    aiMsg.content += '\n\n❌ ' + String(err);
    this.repairMessages = [...this.repairMessages];
  } finally {
    this.repairSending = false;
  }
},

async runRepairRestart() {
  try {
    this.repairMessages.push({ _type: 'system', content: '正在重启 gateway...' });
    await this.httpJson('/setup/api/repair/restart', { method: 'POST' });
    this.repairMessages.push({ _type: 'system', content: '✅ Gateway 重启指令已发送' });
  } catch (e) {
    this.repairMessages.push({ _type: 'system', content: '❌ 重启失败: ' + String(e) });
  }
  this.repairMessages = [...this.repairMessages];
},

async runRepairViewLogs() {
  try {
    const r = await this.httpJson('/setup/api/repair/logs?n=50');
    this.repairLogs = r.lines.join('\n') || '(暂无日志)';
    this.repairShowLogs = true;
  } catch (e) {
    this.repairLogs = '❌ ' + String(e);
    this.repairShowLogs = true;
  }
},
```

- [ ] **Step 5: 在 setup.html 的「配置完成」区域（`x-show="isReady && configured"`）的末尾，现有 `log` 输出框之后，插入修复助手面板**

找到：
```html
<div x-show="log" class="bg-neutral-100 ... whitespace-pre-wrap max-h-64 overflow-y-auto" x-text="log"></div>
```
（这是 `x-show="isReady && configured"` 区域里的最后一个元素）

在其之后插入修复助手面板：

```html
<!-- 修复助手面板 -->
<div class="mt-6 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl shadow-sm dark:shadow-none overflow-hidden">
  <div class="p-4 border-b border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
    <div>
      <h3 class="font-semibold" x-text="t('repairTitle')"></h3>
      <p class="text-xs text-neutral-500 mt-0.5" x-text="t('repairDesc')"></p>
    </div>
    <div class="flex gap-2">
      <button @click="runRepairRestart()" :disabled="repairSending" class="text-xs px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 disabled:opacity-50 transition-colors" x-text="t('repairRestart')"></button>
      <button @click="runRepairViewLogs()" class="text-xs px-3 py-1.5 rounded-lg bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-300 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 transition-colors" x-text="t('repairViewLogs')"></button>
    </div>
  </div>

  <div x-show="!repairChatAvailable" class="px-4 py-3 text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20" x-text="t('repairNoKey')"></div>

  <!-- 日志展开区 -->
  <div x-show="repairShowLogs" x-cloak class="border-b border-neutral-200 dark:border-neutral-800">
    <div class="flex items-center justify-between px-4 py-2">
      <span class="text-xs font-medium text-neutral-500">Gateway Logs</span>
      <button @click="repairShowLogs = false" class="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200">✕</button>
    </div>
    <pre class="px-4 pb-3 font-mono text-xs text-neutral-600 dark:text-neutral-400 whitespace-pre-wrap max-h-48 overflow-y-auto" x-text="repairLogs"></pre>
  </div>

  <!-- 消息列表 -->
  <div class="p-4 space-y-3 max-h-96 overflow-y-auto min-h-[80px]">
    <template x-for="(msg, idx) in repairMessages" :key="idx">
      <div>
        <!-- 用户消息 -->
        <div x-show="msg._type === 'user'" class="flex justify-end">
          <div class="bg-red-600 text-white text-sm px-4 py-2 rounded-2xl rounded-tr-sm max-w-[80%]" x-text="msg.content"></div>
        </div>
        <!-- AI 消息 -->
        <div x-show="msg._type === 'assistant'" class="flex flex-col gap-1">
          <!-- tool calls -->
          <template x-for="(tc, ti) in (msg._toolCalls || [])" :key="ti">
            <div class="bg-neutral-100 dark:bg-neutral-800 rounded-lg px-3 py-2 text-xs font-mono">
              <div class="flex items-center gap-2">
                <span x-text="t('repairToolCall')"></span>
                <span class="font-medium text-neutral-700 dark:text-neutral-300" x-text="tc.name"></span>
                <button x-show="tc._output" @click="tc._expanded = !tc._expanded" class="ml-auto text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200 text-xs" x-text="tc._expanded ? t('repairCollapse') : t('repairExpand')"></button>
              </div>
              <pre x-show="tc._expanded && tc._output" class="mt-2 text-neutral-500 dark:text-neutral-400 whitespace-pre-wrap max-h-32 overflow-y-auto" x-text="tc._output"></pre>
            </div>
          </template>
          <!-- text content -->
          <div x-show="msg.content" class="bg-neutral-50 dark:bg-neutral-800/50 border border-neutral-200 dark:border-neutral-700 text-sm px-4 py-2 rounded-2xl rounded-tl-sm max-w-[90%] text-neutral-800 dark:text-neutral-200 whitespace-pre-wrap" x-text="msg.content"></div>
        </div>
        <!-- 系统消息 -->
        <div x-show="msg._type === 'system'" class="text-center">
          <span class="text-xs text-neutral-400 dark:text-neutral-600" x-text="msg.content"></span>
        </div>
      </div>
    </template>
    <!-- sending indicator -->
    <div x-show="repairSending" class="flex gap-1 items-center px-1">
      <div class="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" style="animation-delay:0ms"></div>
      <div class="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" style="animation-delay:150ms"></div>
      <div class="w-1.5 h-1.5 bg-neutral-400 rounded-full animate-bounce" style="animation-delay:300ms"></div>
    </div>
  </div>

  <!-- 输入区 -->
  <div class="border-t border-neutral-200 dark:border-neutral-800 p-3 flex gap-2">
    <input
      x-model="repairInput"
      @keydown.enter.prevent="sendRepairMessage()"
      :placeholder="t('repairPlaceholder')"
      :disabled="repairSending || !repairChatAvailable"
      class="flex-1 bg-neutral-50 dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm placeholder-neutral-400 dark:placeholder-neutral-600 focus:outline-none focus:border-red-500 transition-colors disabled:opacity-50"
    />
    <button
      @click="sendRepairMessage()"
      :disabled="repairSending || !repairInput.trim() || !repairChatAvailable"
      class="bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
    >
      <span x-show="!repairSending" x-text="t('repairSend')"></span>
      <span x-show="repairSending" x-text="t('repairSending')"></span>
    </button>
  </div>
</div>
```

- [ ] **Step 6: 在浏览器中手动测试**

```bash
docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -v $(pwd)/.tmpdata:/data \
  $(docker build -q .)
```

访问 `http://localhost:8080/setup`，密码 `test`：
1. 完成 setup 后，配置完成区应显示「修复助手」面板
2. 点击「查看日志」按钮，应展开 gateway 日志
3. 在聊天框输入问题并发送，应看到 SSE 流式响应

- [ ] **Step 7: Commit**

```bash
git add src/public/setup.html
git commit -m "feat(repair): add repair assistant panel to setup.html"
```

---

## 自检清单

完成所有 task 后确认：

- [ ] `GET /setup/api/repair/status` 无密码返回 401，有密码返回 200
- [ ] `GET /setup/api/repair/logs` 返回日志数组
- [ ] `POST /setup/api/repair/doctor` 执行 doctor 并返回输出
- [ ] `POST /setup/api/repair/restart` 成功触发 gateway 重启
- [ ] `PATCH /setup/api/repair/config` 修改 openclaw.json 成功
- [ ] `GET /setup/api/repair/config` 返回脱敏配置
- [ ] `POST /setup/api/repair/chat` 在 gateway 宕机时仍可使用
- [ ] setup.html 修复助手面板在「配置完成」状态下可见
- [ ] 发送消息后 SSE 流式展示 AI 回复
- [ ] tool call 结果可展开/折叠
- [ ] `repairAiKey` 不出现在任何 HTTP 响应中
