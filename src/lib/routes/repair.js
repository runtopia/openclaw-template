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

async function executeTool(name, args, ctx) {
  const { gatewayManager, runCmd, OPENCLAW_NODE, clawArgs, configFilePath, restartGateway } = ctx;
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

export function createRepairRouter({
  requireSetupAuth,
  instanceSecret,
  runCmd,
  clawArgs,
  OPENCLAW_NODE,
  restartGateway,
  configFilePath,
  gatewayManager,
  getRepairAiKey,
}) {
  const router = express.Router();

  // 双重认证：SETUP_PASSWORD (Basic Auth) 或 ONECLAW_INSTANCE_SECRET (Bearer)
  function requireRepairAuth(req, res, next) {
    if (instanceSecret) {
      const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/, "");
      if (bearer === instanceSecret) return next();
    }
    return requireSetupAuth(req, res, next);
  }

  // GET /status
  router.get("/status", requireRepairAuth, (req, res) => {
    res.json({
      ok: true,
      gatewayReady: gatewayManager.isGatewayReady(),
      gatewayStarting: gatewayManager.isGatewayStarting(),
      uptime: process.uptime(),
      repairChatAvailable: getRepairAiKey() !== null,
    });
  });

  // GET /logs?n=100
  router.get("/logs", requireRepairAuth, (req, res) => {
    const n = Math.min(parseInt(req.query.n || "100", 10) || 100, 500);
    const lines = gatewayManager.getRecentLogs(n);
    res.json({ ok: true, lines });
  });

  // POST /doctor
  router.post("/doctor", requireRepairAuth, async (_req, res) => {
    try {
      const result = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix", "--yes"]));
      res.json({ ok: result.code === 0, output: result.output });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // POST /restart
  router.post("/restart", requireRepairAuth, async (_req, res) => {
    try {
      await restartGateway();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // PATCH /config
  router.patch("/config", requireRepairAuth, (req, res) => {
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

  // GET /config (redacted)
  router.get("/config", requireRepairAuth, (req, res) => {
    try {
      const cfgPath = configFilePath();
      if (!fs.existsSync(cfgPath)) return res.json({ ok: true, config: null });
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      res.json({ ok: true, config: redactConfig(raw) });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // POST /chat — SSE streaming with tool use
  router.post("/chat", requireRepairAuth, async (req, res) => {
    const repairAiKey = getRepairAiKey();
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

    function emit(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }

    const toolCtx = { gatewayManager, runCmd, OPENCLAW_NODE, clawArgs, configFilePath, restartGateway };
    const systemPrompt = "你是 OpenClaw 修复助手。诊断并修复 gateway 配置和运行问题。使用工具获取信息再采取行动，解释你的每一步操作。";
    const isAnthropic = repairAiKey.api === "anthropic-messages";

    // Anthropic 格式的工具定义
    const REPAIR_TOOLS_ANTHROPIC = REPAIR_TOOLS.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));

    // history 格式：OpenAI 包含 system，Anthropic 把 system 单独传
    const history = isAnthropic
      ? [...messages]
      : [{ role: "system", content: systemPrompt }, ...messages];

    const MAX_ROUNDS = 10;
    let round = 0;

    try {
      while (round < MAX_ROUNDS) {
        round++;

        let aiRes;
        if (isAnthropic) {
          aiRes = await fetch(`${repairAiKey.baseUrl}/messages`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-api-key": repairAiKey.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model: repairAiKey.model,
              max_tokens: 4096,
              system: systemPrompt,
              messages: history,
              tools: REPAIR_TOOLS_ANTHROPIC,
              tool_choice: { type: "auto" },
            }),
          });
        } else {
          aiRes = await fetch(`${repairAiKey.baseUrl}/chat/completions`, {
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
        }

        if (!aiRes.ok) {
          emit({ type: "error", message: `AI API error ${aiRes.status}` });
          break;
        }

        const data = await aiRes.json();

        if (isAnthropic) {
          // Anthropic 响应格式
          const textBlock = data.content?.find(b => b.type === "text");
          if (textBlock?.text) emit({ type: "text", delta: textBlock.text });

          if (data.stop_reason === "tool_use") {
            const toolBlocks = data.content.filter(b => b.type === "tool_use");
            // 把 assistant 消息加入 history
            history.push({ role: "assistant", content: data.content });
            const toolResults = [];
            for (const tb of toolBlocks) {
              emit({ type: "tool_call", id: tb.id, name: tb.name, input: tb.input });
              const output = await executeTool(tb.name, tb.input, toolCtx);
              emit({ type: "tool_result", id: tb.id, name: tb.name, output });
              toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: output });
            }
            history.push({ role: "user", content: toolResults });
            continue;
          }
          history.push({ role: "assistant", content: data.content });
        } else {
          // OpenAI 响应格式
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

  return router;
}
