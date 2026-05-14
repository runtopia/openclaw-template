// Setup wizard routes.

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VALID_FLOWS = ["quickstart", "advanced", "manual"];
const VALID_AUTH_CHOICES = [
  "codex-cli", "openai-codex", "openai-api-key",
  "claude-cli", "token", "apiKey",
  "gemini-api-key", "google-antigravity", "google-gemini-cli",
  "openrouter-api-key", "ai-gateway-api-key",
  "moonshot-api-key", "kimi-code-api-key",
  "zai-api-key", "minimax-api", "minimax-api-lightning",
  "qwen-portal", "github-copilot", "copilot-proxy",
  "synthetic-api-key", "opencode-zen",
  "custom-openai-compatible",
  "custom-anthropic-compatible",
];
const VALID_CUSTOM_API_FORMATS = ["openai-completions", "anthropic-messages"];

function validatePayload(payload) {
  if (payload.flow && !VALID_FLOWS.includes(payload.flow)) return `Invalid flow: ${payload.flow}`;
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) return `Invalid authChoice: ${payload.authChoice}`;
  if (payload.customApiFormat && !VALID_CUSTOM_API_FORMATS.includes(payload.customApiFormat)) return `Invalid customApiFormat: ${payload.customApiFormat}`;
  for (const field of ["telegramToken", "discordToken", "slackBotToken", "slackAppToken", "authSecret", "model", "customBaseUrl", "customProviderId", "feishuAppId", "feishuAppSecret"]) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") return `Invalid ${field}: must be a string`;
  }
  const DM_POLICIES = ["open", "pairing"];
  for (const field of ["telegramDmPolicy", "discordDmPolicy", "feishuDmPolicy", "whatsappDmPolicy", "webchatDmPolicy"]) {
    if (payload[field] !== undefined && !DM_POLICIES.includes(payload[field])) return `Invalid ${field}: must be open or pairing`;
  }
  return null;
}

export function createSetupRouter({
  SETUP_PASSWORD, OPENCLAW_NODE, clawArgs, runCmd, isConfigured,
  ensureGatewayRunning, restartGateway, stateDir, workspaceDir, gatewayToken,
  ENABLE_WEB_TUI,
}) {
  const router = express.Router();

  const rateLimiter = {
    attempts: new Map(), windowMs: 60_000, maxAttempts: 50,
    isRateLimited(ip) {
      const now = Date.now();
      const data = this.attempts.get(ip);
      if (!data || now - data.windowStart > this.windowMs) { this.attempts.set(ip, { windowStart: now, count: 1 }); return false; }
      data.count++;
      return data.count > this.maxAttempts;
    },
  };
  const rateLimiterCleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, data] of rateLimiter.attempts) {
      if (now - data.windowStart > rateLimiter.windowMs) rateLimiter.attempts.delete(ip);
    }
  }, 60_000);

  function requireSetupAuth(req, res, next) {
    if (!SETUP_PASSWORD) return res.status(500).type("text/plain").send("SETUP_PASSWORD is not set.");
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (rateLimiter.isRateLimited(ip)) return res.status(429).type("text/plain").send("Too many requests.");
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) { res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"'); return res.status(401).send("Auth required"); }
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : "";
    const passwordHash = crypto.createHash("sha256").update(password).digest();
    const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
    if (!crypto.timingSafeEqual(passwordHash, expectedHash)) { res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"'); return res.status(401).send("Invalid password"); }
    return next();
  }

  function verifyTuiAuth(req) {
    if (!SETUP_PASSWORD) return false;
    const header = req.headers.authorization || "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) return false;
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : "";
    const passwordHash = crypto.createHash("sha256").update(password).digest();
    const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
    return crypto.timingSafeEqual(passwordHash, expectedHash);
  }

  // 渠道 ID → openclaw 插件 ID 列表(任一可用即认为渠道可用)
  // stock 内置: telegram, slack 在 openclaw 主包里
  // 非内置: 需要 Dockerfile 单独 npm install -g
  //   discord    ← @openclaw/discord
  //   whatsapp   ← @openclaw/whatsapp
  //   feishu     ← @larksuite/openclaw-lark           (插件 id 可能为 lark / feishu)
  //   wechat     ← @tencent-weixin/openclaw-weixin    (插件 id 可能为 weixin / wechat)
  //   webchat    ← @openclaw/webchat 或内置
  const CHANNEL_PLUGIN_IDS = {
    telegram: ["telegram"],
    slack: ["slack"],
    discord: ["discord"],
    whatsapp: ["whatsapp"],
    feishu: ["feishu", "lark", "openclaw-lark"],
    wechat: ["wechat", "weixin", "openclaw-weixin"],
    webchat: ["webchat"],
  };

  let cachedVersion = null;
  let cachedChannelsHelp = null;
  let cachedAvailableChannels = null;
  async function getOpenclawInfo() {
    if (!cachedVersion) {
      const [v, h, p] = await Promise.all([
        runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
        runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
        runCmd(OPENCLAW_NODE, clawArgs(["plugins", "list", "--json"])),
      ]);
      cachedVersion = v.output.trim();
      cachedChannelsHelp = h.output;
      // 解析已安装插件,得出可用渠道
      const installedIds = new Set();
      try {
        const parsed = JSON.parse(p.output);
        for (const plugin of parsed.plugins || []) {
          if (plugin.id) installedIds.add(plugin.id);
        }
      } catch (err) {
        console.warn(`[setup] failed to parse plugins list: ${err.message}`);
      }
      cachedAvailableChannels = {};
      for (const [channelId, pluginIds] of Object.entries(CHANNEL_PLUGIN_IDS)) {
        cachedAvailableChannels[channelId] = pluginIds.some((pid) => installedIds.has(pid));
      }
    }
    return { version: cachedVersion, channelsHelp: cachedChannelsHelp, availableChannels: cachedAvailableChannels };
  }

  function buildOnboardArgs(payload) {
    const args = [
      "onboard", "--non-interactive", "--accept-risk", "--json",
      "--no-install-daemon", "--skip-health",
      "--workspace", workspaceDir,
      "--gateway-bind", "loopback",
      "--gateway-port", "18789",
      "--gateway-auth", "token",
      "--gateway-token", gatewayToken,
      "--flow", payload.flow || "quickstart",
    ];
    if (payload.authChoice) {
      // custom provider：onboard 阶段统一用 openai-api-key 走，post-onboard 再覆写 provider 配置
      const effectiveAuthChoice = (payload.authChoice === "custom-openai-compatible" || payload.authChoice === "custom-anthropic-compatible")
        ? "openai-api-key"
        : payload.authChoice;
      args.push("--auth-choice", effectiveAuthChoice);
      const secret = (payload.authSecret || "").trim();
      const map = {
        "openai-api-key": "--openai-api-key", apiKey: "--anthropic-api-key",
        "openrouter-api-key": "--openrouter-api-key", "ai-gateway-api-key": "--ai-gateway-api-key",
        "moonshot-api-key": "--moonshot-api-key", "kimi-code-api-key": "--kimi-code-api-key",
        "gemini-api-key": "--gemini-api-key", "zai-api-key": "--zai-api-key",
        "minimax-api": "--minimax-api-key", "minimax-api-lightning": "--minimax-api-key",
        "synthetic-api-key": "--synthetic-api-key", "opencode-zen": "--opencode-zen-api-key",
        "custom-openai-compatible": "--openai-api-key",
        "custom-anthropic-compatible": "--openai-api-key",
      };
      const flag = map[payload.authChoice];
      if (flag && secret) args.push(flag, secret);
      if (payload.authChoice === "token" && secret) args.push("--token-provider", "anthropic", "--token", secret);
    }
    return args;
  }

  router.get("/", requireSetupAuth, (_req, res) => res.sendFile(path.join(process.cwd(), "src", "public", "setup.html")));
  router.get("/styles.css", (_req, res) => { res.type("text/css"); res.sendFile(path.join(process.cwd(), "src", "public", "styles.css")); });

  router.get("/api/status", requireSetupAuth, async (_req, res) => {
    const { version, channelsHelp, availableChannels } = await getOpenclawInfo();
    const authGroups = [
      { value: "openai", label: "OpenAI", hint: "Codex OAuth + API key", options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ]},
      { value: "anthropic", label: "Anthropic", hint: "Claude Code CLI + API key", options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ]},
      { value: "google", label: "Google", hint: "Gemini API key + OAuth", options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ]},
      { value: "openrouter", label: "OpenRouter", hint: "API key", options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }]},
      { value: "ai-gateway", label: "Vercel AI Gateway", hint: "API key", options: [{ value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" }]},
      { value: "moonshot", label: "Moonshot AI", hint: "Kimi K2 + Kimi Code", options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ]},
      { value: "zai", label: "Z.AI (GLM 4.7)", hint: "API key", options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }]},
      { value: "minimax", label: "MiniMax", hint: "M2.1 (recommended)", options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ]},
      { value: "qwen", label: "Qwen", hint: "OAuth", options: [{ value: "qwen-portal", label: "Qwen OAuth" }]},
      { value: "copilot", label: "Copilot", hint: "GitHub + local proxy", options: [
        { value: "github-copilot", label: "GitHub Copilot" },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ]},
      { value: "synthetic", label: "Synthetic", hint: "Anthropic-compatible", options: [{ value: "synthetic-api-key", label: "Synthetic API key" }]},
      { value: "opencode-zen", label: "OpenCode Zen", hint: "API key", options: [{ value: "opencode-zen", label: "OpenCode Zen" }]},
      { value: "custom", label: "Custom Provider", hint: "OpenAI / Anthropic compatible", options: [
        { value: "custom-openai-compatible", label: "Custom — OpenAI-compatible (chat/completions)" },
        { value: "custom-anthropic-compatible", label: "Custom — Anthropic-compatible (messages)" },
      ]},
    ];
    res.json({ configured: isConfigured(), openclawVersion: version, channelsAddHelp: channelsHelp, authGroups, availableChannels, tuiEnabled: ENABLE_WEB_TUI });
  });

  router.post("/api/run", requireSetupAuth, async (req, res) => {
    try {
      if (isConfigured()) {
        await ensureGatewayRunning();
        return res.json({ ok: true, output: "Already configured.\n" });
      }
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });

      const payload = req.body || {};
      const validationError = validatePayload(payload);
      if (validationError) return res.status(400).json({ ok: false, output: validationError });

      const onboardArgs = buildOnboardArgs(payload);
      const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));
      let extra = `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;
      const ok = onboard.code === 0 && isConfigured();

      if (ok) {
        extra += "\n[setup] Configuring gateway settings...\n";
        const r1 = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.controlUi.allowInsecureAuth", "true"]));
        extra += `[config] gateway.controlUi.allowInsecureAuth exit=${r1.code}\n`;
        const r2 = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "gateway.auth.token", gatewayToken]));
        extra += `[config] gateway.auth.token exit=${r2.code}\n`;
        // Include reverse-proxy subnet so WebSocket works through the wrapper.
        // In Docker (colima / Railway) the wrapper runs on 172.x, which appears
        // as ::ffff:172.17.x.x behind the proxy.
        const r3 = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1","::ffff:172.17.0.0/16"]']));
        extra += `[config] gateway.trustedProxies exit=${r3.code}\n`;

        const setupAllowedOrigins = process.env.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS?.trim();
        if (setupAllowedOrigins) {
          const originsArray = setupAllowedOrigins.split(",").map((o) => o.trim()).filter(Boolean);
          const r4 = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.controlUi.allowedOrigins", JSON.stringify(originsArray)]));
          extra += `[config] gateway.controlUi.allowedOrigins exit=${r4.code}\n`;
        } else {
          // Default: allow the wrapper proxy (localhost:$PORT) + OneClaw cloud
          const defaultOrigins = [
            `http://localhost:${process.env.PORT || 8080}`,
            `http://127.0.0.1:${process.env.PORT || 8080}`,
            "https://oneclaw.net",
            "https://www.oneclaw.net",
          ];
          const r4 = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "gateway.controlUi.allowedOrigins", JSON.stringify(defaultOrigins)]));
          extra += `[config] gateway.controlUi.allowedOrigins exit=${r4.code}\n`;
        }

        if (payload.model?.trim()) {
          const r5 = await runCmd(OPENCLAW_NODE, clawArgs(["models", "set", payload.model.trim()]));
          extra += `[models set] exit=${r5.code}\n${r5.output || ""}`;
        }

        // 自定义 Provider：onboard 用 openai-api-key 走通流程，这里覆写成用户指定的 baseUrl + models 列表
        const isCustom = payload.authChoice === "custom-openai-compatible" || payload.authChoice === "custom-anthropic-compatible";
        if (isCustom && payload.customBaseUrl?.trim()) {
          const apiFormat = payload.authChoice === "custom-anthropic-compatible"
            ? "anthropic-messages"
            : (payload.customApiFormat || "openai-completions");
          const baseUrl = payload.customBaseUrl.trim();
          // Provider key: 优先用用户填的，否则从 hostname 智能派生(去掉 www/api/v\d+ 前缀，只取主域)
          let providerKey = payload.customProviderId?.trim() || "";
          if (!providerKey) {
            try {
              const u = new URL(baseUrl);
              const host = u.hostname.toLowerCase().replace(/^(www|api|v\d+)\./i, "");
              const root = host.split(".")[0];
              providerKey = (root || "").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
            } catch {}
          }
          if (!providerKey) providerKey = "custom-provider";
          // 提取不含 provider/ 前缀的 model ID,作为 models 数组的 id
          const rawModel = payload.model?.trim() || "default";
          const bareModelId = rawModel.includes("/") ? rawModel.split("/").slice(1).join("/") : rawModel;
          const input = payload.customVision ? ["text", "image"] : ["text"];
          const customProvider = {
            baseUrl,
            apiKey: (payload.authSecret || "").trim(),
            api: apiFormat,
            models: [{
              id: bareModelId,
              name: `${bareModelId} (${providerKey})`,
              contextWindow: 128000,
              maxTokens: 8192,
              input,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              reasoning: false,
            }],
          };
          const rCustom = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", `models.providers.${providerKey}`, JSON.stringify(customProvider)]));
          extra += `[config] custom provider key=${providerKey} (${apiFormat}, vision=${!!payload.customVision}) exit=${rCustom.code}\n`;

          const primaryModelId = `${providerKey}/${bareModelId}`;
          const rModel = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "agents.defaults.model.primary", primaryModelId]));
          extra += `[config] custom model primary=${primaryModelId} exit=${rModel.code}\n`;

          // 在 agents.defaults.models 里加 alias 映射,跟 openclaw 自身格式对齐
          const aliasMap = { [primaryModelId]: { alias: bareModelId } };
          const rAlias = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", "--merge", "agents.defaults.models", JSON.stringify(aliasMap)]));
          extra += `[config] custom model alias exit=${rAlias.code}\n`;
        }

        const channelsHelp = (await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]))).output || "";
        async function configureChannel(name, cfgObj) {
          if (!channelsHelp.includes(name)) return `\n[${name}] skipped (not in channels add --help)\n`;
          const set = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", `channels.${name}`, JSON.stringify(cfgObj)]));
          const get = await runCmd(OPENCLAW_NODE, clawArgs(["config", "get", `channels.${name}`]));
          return `\n[${name}] config exit=${set.code}\n${set.output || "(no output)"}` +
                 `\n[${name}] verify exit=${get.code}\n${get.output || "(no output)"}`;
        }

        if (payload.telegramToken?.trim()) {
          const dmPolicy = payload.telegramDmPolicy === "open" ? "open" : "pairing";
          extra += await configureChannel("telegram", { enabled: true, dmPolicy, token: payload.telegramToken.trim(), groupPolicy: "allowlist", streamMode: "partial" });
        }
        if (payload.discordToken?.trim()) {
          const dmPolicy = payload.discordDmPolicy === "open" ? "open" : "pairing";
          extra += await configureChannel("discord", { enabled: true, token: payload.discordToken.trim(), groupPolicy: "allowlist", dm: { policy: dmPolicy } });
        }
        if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
          extra += await configureChannel("slack", { enabled: true, botToken: payload.slackBotToken?.trim(), appToken: payload.slackAppToken?.trim() });
        }
        if (payload.feishuAppId?.trim() && payload.feishuAppSecret?.trim()) {
          const dmPolicy = payload.feishuDmPolicy === "pairing" ? "pairing" : "open";
          extra += await configureChannel("feishu", { enabled: true, appId: payload.feishuAppId.trim(), appSecret: payload.feishuAppSecret.trim(), dmPolicy, allowFrom: ["*"] });
        }
        if (payload.whatsappEnabled) {
          const dmPolicy = payload.whatsappDmPolicy === "pairing" ? "pairing" : "open";
          extra += await configureChannel("whatsapp", { enabled: true, dmPolicy, allowFrom: ["*"] });
        }
        if (payload.webchatEnabled) {
          const dmPolicy = payload.webchatDmPolicy === "pairing" ? "pairing" : "open";
          extra += await configureChannel("webchat", { enabled: true, dmPolicy, allowFrom: ["*"] });
        }

        // Ensure non-bundled channel plugins are registered in the plugin
        // entries list so Gateway auto-loads them on restart.
        // Without this, doctor --fix or config reset can drop the entry,
        // causing the plugin (e.g. discord) to be skipped at boot.
        for (const pluginId of ["discord", "whatsapp", "lark", "weixin"]) {
          const r = await runCmd(OPENCLAW_NODE, clawArgs(["config", "set", "--json", `plugins.entries.${pluginId}`, JSON.stringify({ enabled: true })]));
          if (r.code === 0) extra += `[plugin] ${pluginId} entry registered\n`;
        }

        extra += "\n[setup] Starting gateway...\n";
        await restartGateway();
        extra += "[setup] Gateway started.\n";
      }

      return res.status(ok ? 200 : 500).json({ ok, output: `${onboard.output}${extra}` });
    } catch (err) {
      console.error("[/setup/api/run] error:", err);
      return res.status(500).json({ ok: false, output: `Internal error: ${String(err)}` });
    }
  });

  router.get("/api/debug", requireSetupAuth, async (_req, res) => {
    const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
    const help = await runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"]));
    res.json({
      wrapper: { node: process.version, stateDir, workspaceDir, railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null },
      openclaw: { version: v.output.trim(), channelsAddHelpIncludesTelegram: help.output.includes("telegram") },
    });
  });

  router.post("/api/pairing/approve", requireSetupAuth, async (req, res) => {
    const { channel, code } = req.body || {};
    if (!channel || !code) return res.status(400).json({ ok: false, error: "Missing channel or code" });
    const r = await runCmd(OPENCLAW_NODE, clawArgs(["pairing", "approve", String(channel), String(code)]));
    return res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output: r.output });
  });

  router.post("/api/reset", requireSetupAuth, async (_req, res) => {
    try {
      const configFile = process.env.OPENCLAW_CONFIG_PATH?.trim() || path.join(stateDir, "openclaw.json");
      fs.rmSync(configFile, { force: true });
      res.type("text/plain").send("OK - deleted config file.");
    } catch (err) {
      res.status(500).type("text/plain").send(String(err));
    }
  });

  router.post("/api/doctor", requireSetupAuth, async (_req, res) => {
    const result = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--non-interactive", "--repair"]));
    return res.status(result.code === 0 ? 200 : 500).json({ ok: result.code === 0, output: result.output });
  });

  router.cleanup = () => clearInterval(rateLimiterCleanup);
  router.verifyTuiAuth = verifyTuiAuth;

  return router;
}