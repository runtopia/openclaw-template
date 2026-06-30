// Setup wizard routes.

import express from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensureControlUiConfig } from "../control-ui-config.js";
import { patchConfig, setIn, mergeIn } from "../openclaw-config.js";
import { resolvePreinstalledPluginPaths } from "../preinstalled-plugins.js";
import { buildHttpEndpoints } from "../direct-config.js";

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
  for (const field of ["telegramDmPolicy", "discordDmPolicy", "feishuDmPolicy", "whatsappDmPolicy", "wechatDmPolicy"]) {
    if (payload[field] !== undefined && !DM_POLICIES.includes(payload[field])) return `Invalid ${field}: must be open or pairing`;
  }
  return null;
}

export function createRequireSetupAuth(SETUP_PASSWORD) {
  const rateLimiter = {
    attempts: new Map(), windowMs: 60_000, maxAttempts: 50,
    isRateLimited(ip) {
      const now = Date.now();
      const data = this.attempts.get(ip);
      if (!data || now - data.windowStart > this.windowMs) {
        this.attempts.set(ip, { windowStart: now, count: 1 });
        return false;
      }
      data.count++;
      return data.count > this.maxAttempts;
    },
  };

  return function requireSetupAuth(req, res, next) {
    if (!SETUP_PASSWORD) {
      res.status(500).send("SETUP_PASSWORD not configured");
      return;
    }
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    if (rateLimiter.isRateLimited(ip)) {
      return res.status(429).send("Too Many Requests");
    }
    const auth = req.headers.authorization || "";
    const b64 = auth.startsWith("Basic ") ? auth.slice(6) : "";
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    const password = decoded.includes(":") ? decoded.split(":").slice(1).join(":") : decoded;
    try {
      const passwordHash = crypto.createHash("sha256").update(password).digest();
      const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
      if (crypto.timingSafeEqual(passwordHash, expectedHash)) return next();
    } catch {}
    res.setHeader("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    res.status(401).send("Unauthorized");
  };
}

export function createSetupRouter({
  SETUP_PASSWORD, OPENCLAW_NODE, clawArgs, runCmd, isConfigured,
  ensureGatewayRunning, restartGateway, stateDir, workspaceDir, gatewayToken,
  configFilePath, port, internalGatewayHost, internalGatewayPort,
  ENABLE_WEB_TUI,
  onSetupComplete,
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

  // 渠道 ID → openclaw 插件 ID。所有渠道(telegram 除外)都在镜像构建时预装到
  // /opt/openclaw-plugins,通过 plugins.load.paths 发现(见 preinstalled-plugins.js)。
  //   telegram          内置于 openclaw 主包(dist/extensions/telegram)
  //   slack             ← @openclaw/slack
  //   discord           ← @openclaw/discord
  //   feishu            ← @openclaw/feishu
  //   whatsapp          ← @openclaw/whatsapp
  //   wechat(微信)      ← @tencent-weixin/openclaw-weixin(channel/plugin id 为 openclaw-weixin)
  const CHANNEL_PLUGIN_IDS = {
    telegram: ["telegram"],
    slack: ["slack"],
    discord: ["discord"],
    whatsapp: ["whatsapp"],
    feishu: ["feishu"],
    wechat: ["openclaw-weixin"],
  };

  let cachedVersion = null;
  let cachedChannelsHelp = null;
  // All channels supported by the wrapper UI are available. OpenClaw's
  // missing-configured-plugin-install doctor flow will lazy-install the
  // backing plugin on first gateway start when the user actually enables
  // that channel, so the wizard doesn't need to gate the option list on a
  // prebuilt plugin set.
  const availableChannels = Object.fromEntries(Object.keys(CHANNEL_PLUGIN_IDS).map((id) => [id, true]));
  async function getOpenclawInfo() {
    if (!cachedVersion) {
      const [v, h] = await Promise.all([
        runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
        runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
      ]);
      cachedVersion = v.output.trim();
      cachedChannelsHelp = h.output;
    }
    return { version: cachedVersion, channelsHelp: cachedChannelsHelp, availableChannels };
  }

  function buildOnboardArgs(payload) {
    const args = [
      "onboard", "--non-interactive", "--accept-risk", "--json",
      "--no-install-daemon", "--skip-health", "--skip-skills", "--skip-channels",
      "--workspace", workspaceDir,
      "--gateway-bind", "loopback",
      "--gateway-port", "18789",
      "--gateway-auth", "token",
      "--gateway-token", gatewayToken,
      "--flow", payload.flow || "quickstart",
    ];
    if (!payload.authChoice) return args;
    const isCustom = payload.authChoice === "custom-openai-compatible" || payload.authChoice === "custom-anthropic-compatible";
    if (isCustom) {
      // custom provider 走 OpenClaw 原生 --auth-choice custom-api-key 路径。
      // 走 openai-api-key 兜底的旧做法会让 OpenClaw 把默认 model 设成 openai/gpt-5.5,
      // 在 onboard 内部触发 ensureCodexRuntimePluginForModelSelection -> 强制安装
      // @openclaw/codex，进而踩 managed-npm peer scan 失败（~30s 浪费 + 装不上）。
      args.push("--auth-choice", "custom-api-key");
      const baseUrl = (payload.customBaseUrl || "").trim();
      if (baseUrl) args.push("--custom-base-url", baseUrl);
      const secret = (payload.authSecret || "").trim();
      if (secret) args.push("--custom-api-key", secret);
      args.push("--custom-compatibility", payload.authChoice === "custom-anthropic-compatible" ? "anthropic" : "openai");
      const rawModel = (payload.model || "").trim() || "default";
      const bareModelId = rawModel.includes("/") ? rawModel.split("/").slice(1).join("/") : rawModel;
      args.push("--custom-model-id", bareModelId);
      const providerKey = deriveCustomProviderKey(payload.customProviderId, baseUrl);
      if (providerKey) args.push("--custom-provider-id", providerKey);
      if (payload.customVision) args.push("--custom-image-input");
      else args.push("--custom-text-input");
      return args;
    }
    args.push("--auth-choice", payload.authChoice);
    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key", apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key", "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key", "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key", "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key", "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key", "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) args.push(flag, secret);
    if (payload.authChoice === "token" && secret) args.push("--token-provider", "anthropic", "--token", secret);
    return args;
  }

  function deriveCustomProviderKey(rawId, baseUrl) {
    const explicit = (rawId || "").trim();
    if (explicit) return explicit;
    if (!baseUrl) return "";
    try {
      const u = new URL(baseUrl);
      const host = u.hostname.toLowerCase().replace(/^(www|api|v\d+)\./i, "");
      const root = host.split(".")[0];
      return (root || "").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
    } catch {
      return "";
    }
  }

  // Build the per-channel config + plugin install plan based on what the user
  // submitted. `npmSpec=null` marks builtin channels (telegram/slack are
  // included in the openclaw core package); those skip plugin install.
  // `pluginId` mirrors the OpenClaw channel id and goes into plugins.entries
  // so the gateway loader enables it on startup.
  //
  // Field shapes must match the openclaw zod schema exactly — extra fields
  // throw "must NOT have additional properties" at gateway startup. Cross-
  // reference src/lib/channel-manifest.js (which is the canonical shape for
  // env-driven reconcile) when adding fields.
  function buildChannelPlan(payload, channelsHelp) {
    const plan = [];
    // Every channel the UI exposes is pre-installed into /opt (see
    // preinstalled-plugins.js) and discovered via plugins.load.paths, so it's
    // always available. We must NOT gate on `channels add --help` here: that
    // help text doesn't list a plugin-backed channel until the plugin is
    // enabled in config, which hasn't happened yet during first-time setup.
    const supported = (name) => availableChannels[name] === true;
    const openAllowFrom = (policy) => (policy === "open" ? { allowFrom: ["*"] } : {});

    if (payload.telegramToken?.trim() && supported("telegram")) {
      const dmPolicy = payload.telegramDmPolicy === "pairing" ? "pairing" : "open";
      plan.push({
        name: "telegram",
        npmSpec: null,
        pluginId: null,
        // openclaw@2026.5.7+ schema: botToken (not token); no streamMode;
        // allowFrom required when dmPolicy=open.
        config: {
          enabled: true,
          botToken: payload.telegramToken.trim(),
          dmPolicy,
          ...openAllowFrom(dmPolicy),
          groupPolicy: "allowlist",
        },
      });
    }
    if (payload.discordToken?.trim() && supported("discord")) {
      const dmPolicy = payload.discordDmPolicy === "pairing" ? "pairing" : "open";
      plan.push({
        name: "discord",
        npmSpec: "@openclaw/discord@2026.6.10",
        pluginId: "discord",
        config: {
          enabled: true,
          token: payload.discordToken.trim(),
          dm: { policy: dmPolicy, ...openAllowFrom(dmPolicy) },
          groupPolicy: "allowlist",
        },
      });
    }
    if ((payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) && supported("slack")) {
      plan.push({
        name: "slack",
        npmSpec: "@openclaw/slack@2026.6.10",
        pluginId: "slack",
        config: {
          enabled: true,
          botToken: payload.slackBotToken?.trim(),
          appToken: payload.slackAppToken?.trim(),
        },
      });
    }
    if (payload.feishuAppId?.trim() && payload.feishuAppSecret?.trim() && supported("feishu")) {
      const dmPolicy = payload.feishuDmPolicy === "pairing" ? "pairing" : "open";
      plan.push({
        name: "feishu",
        npmSpec: "@openclaw/feishu@2026.6.10",
        pluginId: "feishu",
        config: {
          enabled: true,
          appId: payload.feishuAppId.trim(),
          appSecret: payload.feishuAppSecret.trim(),
          dmPolicy,
          ...openAllowFrom(dmPolicy),
        },
      });
    }
    if (payload.whatsappEnabled && supported("whatsapp")) {
      const dmPolicy = payload.whatsappDmPolicy === "pairing" ? "pairing" : "open";
      plan.push({
        name: "whatsapp",
        npmSpec: "@openclaw/whatsapp@2026.6.10",
        pluginId: "whatsapp",
        config: {
          enabled: true,
          dmPolicy,
          ...openAllowFrom(dmPolicy),
        },
      });
    }
    if (payload.wechatEnabled && supported("wechat")) {
      const dmPolicy = payload.wechatDmPolicy === "pairing" ? "pairing" : "open";
      // WeChat = third-party @tencent-weixin/openclaw-weixin; its channel id
      // and plugin id are both "openclaw-weixin". QR login happens at runtime
      // via `openclaw channels login --channel openclaw-weixin`.
      plan.push({
        name: "openclaw-weixin",
        npmSpec: "@tencent-weixin/openclaw-weixin@2.4.6",
        pluginId: "openclaw-weixin",
        config: {
          enabled: true,
          dmPolicy,
          ...openAllowFrom(dmPolicy),
        },
      });
    }
    return plan;
  }

  router.get("/", requireSetupAuth, (_req, res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate");
    res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
  });
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
        // Single-write strategy: collect every config change into one
        // patchConfig() call. Each `openclaw config set` shells out to a
        // fresh node process (~3-5s cold start), so 10+ calls back-to-back
        // used to add 30-60s of pure overhead here. One in-process JSON
        // mutation drops that to a few ms — and triggers fewer gateway
        // hot-reload events as a bonus.
        extra += "\n[setup] Writing config...\n";
        const isCustom = payload.authChoice === "custom-openai-compatible" || payload.authChoice === "custom-anthropic-compatible";

        // Pre-compute custom provider shape (used inside patchConfig).
        let customProviderKey = null;
        let customPrimaryModelId = null;
        if (isCustom && payload.customBaseUrl?.trim()) {
          const baseUrl = payload.customBaseUrl.trim();
          customProviderKey = deriveCustomProviderKey(payload.customProviderId, baseUrl) || "custom-provider";
          const rawModel = payload.model?.trim() || "default";
          const bareModelId = rawModel.includes("/") ? rawModel.split("/").slice(1).join("/") : rawModel;
          customPrimaryModelId = `${customProviderKey}/${bareModelId}`;
        }

        // Build channel config + install plan. npmSpec=null means the channel
        // is OpenClaw-builtin (telegram) and doesn't need a plugin install.
        const { channelsHelp } = await getOpenclawInfo();
        const channelPlan = buildChannelPlan(payload, channelsHelp);

        patchConfig(configFilePath(), (cfg) => {
          setIn(cfg, "gateway.auth.token", gatewayToken);
          // Reverse-proxy subnet so WebSocket works through the wrapper.
          // In Docker (colima / Railway) the wrapper runs on 172.x, which
          // appears as ::ffff:172.17.x.x behind the proxy.
          setIn(cfg, "gateway.trustedProxies", ["127.0.0.1", "::ffff:172.17.0.0/16"]);

          // HTTP /v1/* OpenAI 兼容端点（env 注入，默认全关）。见 direct-config.js。
          const httpEndpoints = buildHttpEndpoints(process.env);
          if (httpEndpoints) setIn(cfg, "gateway.http.endpoints", httpEndpoints);

          // Discover the image-baked plugins (clawrouters/discord/feishu) from
          // their fixed /opt path so enabling a channel needs no runtime npm
          // install. See preinstalled-plugins.js.
          const loadPaths = resolvePreinstalledPluginPaths();
          if (loadPaths.length > 0) setIn(cfg, "plugins.load.paths", loadPaths);

          if (isCustom && customProviderKey) {
            const baseUrl = payload.customBaseUrl.trim();
            const rawModel = payload.model?.trim() || "default";
            const bareModelId = rawModel.includes("/") ? rawModel.split("/").slice(1).join("/") : rawModel;
            const apiFormat = payload.authChoice === "custom-anthropic-compatible" ? "anthropic-messages" : "openai-completions";
            const customProvider = {
              baseUrl,
              apiKey: (payload.authSecret || "").trim(),
              api: apiFormat,
              // contextWindow / maxTokens / vision aren't set by `openclaw onboard --custom-*`,
              // so we overwrite the provider entry here with sensible defaults.
              models: [{
                id: bareModelId,
                name: `${bareModelId} (${customProviderKey})`,
                contextWindow: 200000,
                maxTokens: 8192,
                input: payload.customVision ? ["text", "image"] : ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                reasoning: false,
              }],
            };
            setIn(cfg, `models.providers.${customProviderKey}`, customProvider);
            setIn(cfg, "agents.defaults.model.primary", customPrimaryModelId);
            mergeIn(cfg, "agents.defaults.models", { [customPrimaryModelId]: { alias: bareModelId } });
          } else if (payload.model?.trim()) {
            setIn(cfg, "agents.defaults.model.primary", payload.model.trim());
          }

          for (const ch of channelPlan) {
            setIn(cfg, `channels.${ch.name}`, ch.config);
            if (ch.pluginId) setIn(cfg, `plugins.entries.${ch.pluginId}`, { enabled: true });
          }
        });
        extra += `[config] patched gateway + provider + ${channelPlan.length} channel(s) in one write\n`;

        // controlUi is patched separately because the same helper runs at
        // server startup and from auto-config — keeping it self-contained
        // is simpler than threading the patcher through.
        const controlUiPatched = ensureControlUiConfig({
          configPath: configFilePath(),
          port,
          internalGatewayHost,
          internalGatewayPort,
          allowedOriginsEnv: process.env.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS,
        });
        extra += `[config] controlUi patched=${controlUiPatched}\n`;

        // Channel plugins (discord/feishu) are baked into the image and found
        // via plugins.load.paths set above — no runtime install needed. This
        // loop only runs as a fallback on non-Docker dev boxes where the /opt
        // prebuilts are absent (so first-time setup still works locally).
        const preinstalled = resolvePreinstalledPluginPaths().length > 0;
        for (const ch of channelPlan) {
          if (!ch.npmSpec || preinstalled) continue;
          extra += `\n[plugin] installing ${ch.name} (${ch.npmSpec}) — this may take 30-60s...\n`;
          const r = await runCmd(OPENCLAW_NODE, clawArgs(["plugins", "install", ch.npmSpec, "--pin"]));
          if (r.code === 0) {
            extra += `[plugin] ${ch.name} installed\n`;
          } else {
            const tail = (r.output || "").split("\n").slice(-5).join("\n");
            extra += `[plugin] ${ch.name} install FAILED exit=${r.code}\n${tail}\n`;
          }
        }

        extra += "\n[setup] Starting gateway...\n";
        await restartGateway();
        extra += "[setup] Gateway started.\n";
        if (typeof onSetupComplete === "function") onSetupComplete();
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
