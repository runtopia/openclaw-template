import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import express from "express";
import httpProxy from "http-proxy";
import pty from "node-pty";
import { WebSocketServer } from "ws";

const PORT = Number.parseInt(process.env.PORT ?? "8080", 10);
const STATE_DIR =
  process.env.OPENCLAW_STATE_DIR?.trim() ||
  path.join(os.homedir(), ".openclaw");
const WORKSPACE_DIR =
  process.env.OPENCLAW_WORKSPACE_DIR?.trim() ||
  path.join(STATE_DIR, "workspace");

const SETUP_PASSWORD = process.env.SETUP_PASSWORD?.trim();

function resolveGatewayToken() {
  // Check both env var names for backwards compatibility
  const envTok = (process.env.OPENCLAW_GATEWAY_TOKEN || process.env.GATEWAY_TOKEN)?.trim();
  if (envTok) return envTok;

  const tokenPath = path.join(STATE_DIR, "gateway.token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch (err) {
    console.warn(
      `[gateway-token] could not read existing token: ${err.code || err.message}`,
    );
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(tokenPath, generated, { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    console.warn(
      `[gateway-token] could not persist token: ${err.code || err.message}`,
    );
  }
  return generated;
}

const OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken();
process.env.OPENCLAW_GATEWAY_TOKEN = OPENCLAW_GATEWAY_TOKEN;

let cachedOpenclawVersion = null;
let cachedChannelsHelp = null;

async function getOpenclawInfo() {
  if (!cachedOpenclawVersion) {
    const [version, channelsHelp] = await Promise.all([
      runCmd(OPENCLAW_NODE, clawArgs(["--version"])),
      runCmd(OPENCLAW_NODE, clawArgs(["channels", "add", "--help"])),
    ]);
    cachedOpenclawVersion = version.output.trim();
    cachedChannelsHelp = channelsHelp.output;
  }
  return { version: cachedOpenclawVersion, channelsHelp: cachedChannelsHelp };
}

const INTERNAL_GATEWAY_PORT = Number.parseInt(
  process.env.INTERNAL_GATEWAY_PORT ?? "18789",
  10,
);
const INTERNAL_GATEWAY_HOST = process.env.INTERNAL_GATEWAY_HOST ?? "127.0.0.1";
const GATEWAY_TARGET = `http://${INTERNAL_GATEWAY_HOST}:${INTERNAL_GATEWAY_PORT}`;

const OPENCLAW_ENTRY =
  process.env.OPENCLAW_ENTRY?.trim() || "/openclaw/dist/entry.js";
const OPENCLAW_NODE = process.env.OPENCLAW_NODE?.trim() || "node";

const ENABLE_WEB_TUI = process.env.ENABLE_WEB_TUI?.toLowerCase() === "true";
const TUI_IDLE_TIMEOUT_MS = Number.parseInt(
  process.env.TUI_IDLE_TIMEOUT_MS ?? "300000",
  10,
);
const TUI_MAX_SESSION_MS = Number.parseInt(
  process.env.TUI_MAX_SESSION_MS ?? "1800000",
  10,
);

// ============== OneClaw Integration Configuration ==============
const ONECLAW_API_URL = process.env.ONECLAW_API_URL?.trim() || 'https://www.oneclaw.net/api';
const ONECLAW_INSTANCE_ID = process.env.ONECLAW_INSTANCE_ID?.trim();
const ONECLAW_INSTANCE_SECRET = process.env.ONECLAW_INSTANCE_SECRET?.trim();
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const REMINDERS_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

let lastHeartbeat = null;
let heartbeatInterval = null;
let remindersInterval = null;

// Usage stats tracking
let usageStats = {
  messagesThisSession: 0,
  tokensThisSession: 0,
  lastModel: null,
};

// Cached personality (fetched from OneClaw dashboard)
let cachedPersonality = null;

function clawArgs(args) {
  return [OPENCLAW_ENTRY, ...args];
}

function configPath() {
  return (
    process.env.OPENCLAW_CONFIG_PATH?.trim() ||
    path.join(STATE_DIR, "openclaw.json")
  );
}

function isConfigured() {
  try {
    return fs.existsSync(configPath());
  } catch {
    return false;
  }
}

let gatewayProc = null;
let gatewayStarting = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForGatewayReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const start = Date.now();
  const endpoints = ["/openclaw", "/openclaw", "/", "/health"];

  while (Date.now() - start < timeoutMs) {
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, {
          method: "GET",
        });
        if (res) {
          console.log(`[gateway] ready at ${endpoint}`);
          return true;
        }
      } catch (err) {
        if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
          const msg = err.code || err.message;
          if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
            console.warn(`[gateway] health check error: ${msg}`);
          }
        }
      }
    }
    await sleep(250);
  }
  console.error(`[gateway] failed to become ready after ${timeoutMs / 1000} seconds`);
  return false;
}

async function startGateway() {
  if (gatewayProc) return;
  if (!isConfigured()) throw new Error("Gateway cannot start: not configured");

  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

  const args = [
    "gateway",
    "run",
    "--bind",
    "loopback",
    "--port",
    String(INTERNAL_GATEWAY_PORT),
    "--auth",
    "token",
    "--token",
    OPENCLAW_GATEWAY_TOKEN,
  ];

  gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: STATE_DIR,
      OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
    },
  });

  const safeArgs = args.map((arg, i) =>
    args[i - 1] === "--token" ? "[REDACTED]" : arg
  );
  console.log(
    `[gateway] starting with command: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`,
  );
  console.log(`[gateway] STATE_DIR: ${STATE_DIR}`);
  console.log(`[gateway] WORKSPACE_DIR: ${WORKSPACE_DIR}`);
  console.log(`[gateway] config path: ${configPath()}`);

  gatewayProc.on("error", (err) => {
    console.error(`[gateway] spawn error: ${String(err)}`);
    gatewayProc = null;
  });

  gatewayProc.on("exit", (code, signal) => {
    console.error(`[gateway] exited code=${code} signal=${signal}`);
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      await startGateway();
      const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
      if (!ready) {
        throw new Error("Gateway did not become ready in time");
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

function isGatewayStarting() {
  return gatewayStarting !== null;
}

function isGatewayReady() {
  return gatewayProc !== null && gatewayStarting === null;
}

async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch (err) {
      console.warn(`[gateway] kill error: ${err.message}`);
    }
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}

// ============== OneClaw Integration Functions ==============

async function sendHeartbeat() {
  if (!ONECLAW_API_URL || !ONECLAW_INSTANCE_ID || !ONECLAW_INSTANCE_SECRET) {
    return; // Heartbeat not configured
  }

  try {
    const status = isGatewayReady() ? 'healthy' : isGatewayStarting() ? 'starting' : 'unhealthy';
    const payload = {
      instanceId: ONECLAW_INSTANCE_ID,
      status,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      configured: isConfigured(),
      gatewayReady: isGatewayReady(),
    };

    const response = await fetch(`${ONECLAW_API_URL}/agent/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ONECLAW_INSTANCE_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      lastHeartbeat = new Date();
      console.log(`[heartbeat] sent successfully: ${status}`);
      
      // Process pending commands from server
      try {
        const result = await response.json();
        if (result.commands && Array.isArray(result.commands) && result.commands.length > 0) {
          console.log(`[heartbeat] received ${result.commands.length} pending command(s)`);
          for (const cmd of result.commands) {
            await processCommand(cmd);
          }
        }
      } catch (parseErr) {
        // Response may not be JSON, that's fine
      }
      
      // Also report usage stats if we have any
      if (usageStats.messagesThisSession > 0) {
        await reportStats();
      }
    } else {
      console.warn(`[heartbeat] failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.error(`[heartbeat] error: ${err.message}`);
  }
}

async function sendEvent(event, data = {}) {
  if (!ONECLAW_API_URL || !ONECLAW_INSTANCE_ID || !ONECLAW_INSTANCE_SECRET) {
    return;
  }

  try {
    await fetch(`${ONECLAW_API_URL}/agent/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ONECLAW_INSTANCE_SECRET}`,
      },
      body: JSON.stringify({
        instanceId: ONECLAW_INSTANCE_ID,
        event,
        data,
        timestamp: new Date().toISOString(),
      }),
    });
    console.log(`[event] sent: ${event}`);
  } catch (err) {
    console.error(`[event] error: ${err.message}`);
  }
}

// Report usage statistics to OneClaw backend
async function reportStats() {
  if (!ONECLAW_API_URL || !ONECLAW_INSTANCE_ID || !ONECLAW_INSTANCE_SECRET) {
    return;
  }

  if (usageStats.messagesThisSession === 0) {
    return; // Nothing to report
  }

  try {
    const response = await fetch(`${ONECLAW_API_URL}/agent/stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ONECLAW_INSTANCE_SECRET}`,
      },
      body: JSON.stringify({
        instanceId: ONECLAW_INSTANCE_ID,
        secret: ONECLAW_INSTANCE_SECRET,
        messages: usageStats.messagesThisSession,
        tokens: usageStats.tokensThisSession,
        model: usageStats.lastModel,
      }),
    });

    if (response.ok) {
      console.log(`[stats] reported: ${usageStats.messagesThisSession} messages, ${usageStats.tokensThisSession} tokens`);
      // Reset session counters after successful report
      usageStats.messagesThisSession = 0;
      usageStats.tokensThisSession = 0;
    } else {
      console.warn(`[stats] report failed: ${response.status}`);
    }
  } catch (err) {
    console.error(`[stats] error: ${err.message}`);
  }
}

// Track a message (called when we detect message activity)
function trackMessage(tokens = 0, model = null) {
  usageStats.messagesThisSession++;
  usageStats.tokensThisSession += tokens;
  if (model) {
    usageStats.lastModel = model;
  }
}

// Fetch personality settings from OneClaw dashboard
async function fetchPersonality() {
  if (!ONECLAW_API_URL || !ONECLAW_INSTANCE_ID || !ONECLAW_INSTANCE_SECRET) {
    return { personality: null, template: null };
  }

  try {
    // We need to get userId from instance - for now use instanceId as lookup
    const response = await fetch(`${ONECLAW_API_URL}/agent/personality?instanceId=${ONECLAW_INSTANCE_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ONECLAW_INSTANCE_SECRET}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      cachedPersonality = data.personality;
      console.log(`[personality] fetched: ${cachedPersonality?.botName || 'default'}`);
      if (data.template) {
        console.log(`[template] fetched: ${data.template.name} (${data.template.memoryFiles?.length || 0} files)`);
      }
      return { personality: data.personality, template: data.template };
    }
  } catch (err) {
    console.error(`[personality] fetch error: ${err.message}`);
  }
  return { personality: null, template: null };
}

// ============== Process Pending Commands from OneClaw Dashboard ==============

async function processCommand(cmd) {
  console.log(`[command] processing: ${cmd.type} (id: ${cmd.id})`);
  try {
    switch (cmd.type) {
      case 'apply_template':
        await applyTemplateFromCommand(cmd);
        break;
      default:
        console.warn(`[command] unknown command type: ${cmd.type}`);
    }
  } catch (err) {
    console.error(`[command] error processing ${cmd.type}: ${err.message}`);
  }
}

async function applyTemplateFromCommand(cmd) {
  const { templateId, soulMd, skills } = cmd;
  console.log(`[command] applying template: ${templateId} (skills: ${(skills || []).join(', ') || 'none'})`);

  // Write SOUL.md
  if (soulMd) {
    const soulPath = path.join(WORKSPACE_DIR, 'SOUL.md');
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
    fs.writeFileSync(soulPath, soulMd, 'utf8');
    console.log(`[command] wrote SOUL.md (${soulMd.length} chars)`);
  }

  // Skills from templates are all built-in to openclaw and auto-discovered.
  // Log them for visibility but no installation needed.
  if (skills && skills.length > 0) {
    console.log(`[command] template skills (built-in, auto-loaded): ${skills.join(', ')}`);
  }

  // Restart gateway to pick up the new SOUL.md
  console.log('[command] restarting gateway to apply template...');
  await restartGateway();
  console.log('[command] template applied and gateway restarted');
}

// Environment variable for template ID
const ONECLAW_TEMPLATE_ID = process.env.ONECLAW_TEMPLATE_ID?.trim() || null;

// Apply template from environment variable (called on first startup)
async function applyTemplateFromEnv() {
  if (!ONECLAW_TEMPLATE_ID || !ONECLAW_API_URL) {
    return false;
  }

  // Check if already applied (SOUL.md exists with content)
  const soulPath = path.join(WORKSPACE_DIR, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    const content = fs.readFileSync(soulPath, 'utf8');
    if (content.length > 100) {
      console.log('[template] SOUL.md already exists, skipping template apply');
      return true;
    }
  }

  console.log(`[template] applying template: ${ONECLAW_TEMPLATE_ID}`);
  
  try {
    // Fetch template content from API
    const response = await fetch(`${ONECLAW_API_URL}/templates?id=${ONECLAW_TEMPLATE_ID}`);
    if (!response.ok) {
      console.error(`[template] fetch failed: ${response.status}`);
      return false;
    }
    
    const data = await response.json();
    const template = data.template;
    
    if (!template) {
      console.error('[template] template not found');
      return false;
    }
    
    // Write SOUL.md
    if (template.soulMd) {
      fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
      fs.writeFileSync(soulPath, template.soulMd, 'utf8');
      console.log(`[template] wrote SOUL.md (${template.soulMd.length} chars)`);
    }
    
    // Write memory files
    if (template.memoryFiles && Array.isArray(template.memoryFiles)) {
      for (const file of template.memoryFiles) {
        if (file.path && file.content) {
          const filePath = path.join(WORKSPACE_DIR, file.path);
          const dir = path.dirname(filePath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, file.content, 'utf8');
          console.log(`[template] wrote ${file.path}`);
        }
      }
    }
    
    console.log('[template] template applied successfully');
    return true;
  } catch (err) {
    console.error(`[template] apply error: ${err.message}`);
    return false;
  }
}

// Apply personality to gateway config (system prompt)
async function applyPersonality(personality, template = null) {
  try {
    // Write system prompt to SOUL.md in workspace
    if (personality?.systemPrompt) {
      const soulPath = path.join(WORKSPACE_DIR, 'SOUL.md');
      fs.writeFileSync(soulPath, personality.systemPrompt, 'utf8');
      console.log(`[personality] applied system prompt to ${soulPath}`);
    }
    
    // Apply template memory files if available
    if (template?.memoryFiles && Array.isArray(template.memoryFiles)) {
      for (const file of template.memoryFiles) {
        if (file.path && file.content) {
          const filePath = path.join(WORKSPACE_DIR, file.path);
          // Create directory if needed
          const dir = path.dirname(filePath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(filePath, file.content, 'utf8');
          console.log(`[template] applied ${file.path}`);
        }
      }
    }
  } catch (err) {
    console.error(`[personality] apply error: ${err.message}`);
  }
}

// Check and execute reminders from OneClaw dashboard
async function checkReminders() {
  if (!ONECLAW_API_URL || !ONECLAW_INSTANCE_ID || !ONECLAW_INSTANCE_SECRET) {
    return;
  }

  try {
    const response = await fetch(`${ONECLAW_API_URL}/agent/reminders/due?instanceId=${ONECLAW_INSTANCE_ID}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${ONECLAW_INSTANCE_SECRET}`,
      },
    });

    if (response.ok) {
      const data = await response.json();
      const dueReminders = data.reminders || [];
      
      for (const reminder of dueReminders) {
        console.log(`[reminders] executing: ${reminder.title}`);
        await executeReminder(reminder);
      }
    }
  } catch (err) {
    // Silently fail - reminders are optional
    if (err.message !== 'fetch failed') {
      console.error(`[reminders] check error: ${err.message}`);
    }
  }
}

// Execute a single reminder by sending message to gateway
async function executeReminder(reminder) {
  if (!isGatewayReady()) {
    console.warn(`[reminders] gateway not ready, skipping: ${reminder.title}`);
    return;
  }

  try {
    // Use gateway RPC to trigger a cron-like event
    const response = await fetch(`${GATEWAY_TARGET}/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        method: 'cron.wake',
        params: {
          text: reminder.message,
          source: 'oneclaw-reminder',
          reminderId: reminder.id,
        },
      }),
    });

    if (response.ok) {
      console.log(`[reminders] executed: ${reminder.title}`);
      // Mark reminder as executed
      await markReminderExecuted(reminder.id);
    }
  } catch (err) {
    console.error(`[reminders] execute error: ${err.message}`);
  }
}

// Mark a reminder as executed
async function markReminderExecuted(reminderId) {
  if (!ONECLAW_API_URL || !ONECLAW_INSTANCE_ID || !ONECLAW_INSTANCE_SECRET) {
    return;
  }

  try {
    await fetch(`${ONECLAW_API_URL}/agent/reminders/executed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ONECLAW_INSTANCE_SECRET}`,
      },
      body: JSON.stringify({
        instanceId: ONECLAW_INSTANCE_ID,
        reminderId,
        executedAt: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error(`[reminders] mark executed error: ${err.message}`);
  }
}

function startHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }
  if (remindersInterval) {
    clearInterval(remindersInterval);
  }

  // Send initial heartbeat after 30 seconds
  setTimeout(async () => {
    sendHeartbeat();
    sendEvent('instance_started', { version: cachedOpenclawVersion });
    
    // Fetch and apply personality/template on startup
    const { personality, template } = await fetchPersonality();
    if (personality || template) {
      await applyPersonality(personality, template);
    }
  }, 30_000);

  // Heartbeat every 10 minutes
  heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  
  // Check reminders every minute
  remindersInterval = setInterval(checkReminders, REMINDERS_CHECK_INTERVAL_MS);
  
  console.log(`[heartbeat] started (interval: ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
  console.log(`[reminders] check started (interval: ${REMINDERS_CHECK_INTERVAL_MS / 1000}s)`);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (remindersInterval) {
    clearInterval(remindersInterval);
    remindersInterval = null;
  }
}

// ============== Startup Config Fixes ==============
// Ensure critical config is always present (runs on every start for existing instances)

// Can be overridden via environment variable
const ALLOWED_ORIGINS_ENV = process.env.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS?.trim();
const DEFAULT_ALLOWED_ORIGINS = '["https://oneclaw.net","https://www.oneclaw.net"]';

async function ensureWebSocketConfig() {
  if (!isConfigured()) return;
  
  // Always ensure OneClaw website can connect via WebSocket
  // This fixes existing instances that were deployed before this config was added
  // Can also be set via GATEWAY_CONTROL_UI_ALLOWED_ORIGINS env var
  try {
    // First, ensure allowInsecureAuth is enabled (required for web chat)
    // This disables device identity requirement for Control UI connections
    console.log("[startup-fix] ensuring allowInsecureAuth=true...");
    const authResult = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "gateway.controlUi.allowInsecureAuth", "true"
    ]));
    console.log(`[startup-fix] allowInsecureAuth configured (exit=${authResult.code})`);

    // Patch config JSON directly to bypass schema validation
    // Since OpenClaw v2026.2.14, device-less connections get zero scopes
    // dangerouslyDisableDeviceAuth=true preserves scopes for webchat
    try {
      const configPath = path.join(STATE_DIR, "openclaw.json");
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
        if (config.gateway) {
          if (!config.gateway.controlUi) config.gateway.controlUi = {};
          config.gateway.controlUi.dangerouslyDisableDeviceAuth = true;
          config.gateway.controlUi.allowInsecureAuth = true;
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
          console.log("[startup-fix] patched openclaw.json: dangerouslyDisableDeviceAuth=true");
        }
      }
    } catch (err) {
      console.warn(`[startup-fix] failed to patch config JSON: ${err.message}`);
    }
    
    let origins = DEFAULT_ALLOWED_ORIGINS;
    if (ALLOWED_ORIGINS_ENV) {
      // Parse comma-separated origins from env var and convert to JSON array
      const originsList = ALLOWED_ORIGINS_ENV.split(',').map(o => o.trim()).filter(Boolean);
      origins = JSON.stringify(originsList);
      console.log(`[startup-fix] using allowedOrigins from env: ${origins}`);
    }
    
    console.log("[startup-fix] ensuring WebSocket allowedOrigins config...");
    const result = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "--json", "gateway.controlUi.allowedOrigins", origins
    ]));
    console.log(`[startup-fix] WebSocket allowedOrigins configured (exit=${result.code})`);
    if (result.output) console.log(result.output);
  } catch (err) {
    console.warn(`[startup-fix] failed to set config: ${err.message}`);
  }
}

// ============== Auto-Configuration from Environment Variables ==============
// For managed hosting: auto-configure from env vars without setup wizard

const AUTO_CONFIG_TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const AUTO_CONFIG_DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN?.trim();
const AUTO_CONFIG_FEISHU_APP_ID = process.env.FEISHU_APP_ID?.trim();
const AUTO_CONFIG_FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET?.trim();
function truthyEnv(v) {
  const s = (v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}
const AUTO_CONFIG_WHATSAPP_ENABLED = truthyEnv(process.env.WHATSAPP_ENABLED);
const AUTO_CONFIG_WECHAT_ENABLED = truthyEnv(process.env.WECHAT_ENABLED);
const AUTO_CONFIG_ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const AUTO_CONFIG_OPENAI_KEY = process.env.OPENAI_API_KEY?.trim();
const AUTO_CONFIG_GOOGLE_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
const AUTO_CONFIG_DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY?.trim();
const AUTO_CONFIG_OPENROUTER_KEY = process.env.OPENROUTER_API_KEY?.trim();
const AUTO_CONFIG_CLAWROUTERS_KEY = process.env.CLAWROUTERS_KEY?.trim();
const AUTO_CONFIG_DEFAULT_MODEL = process.env.DEFAULT_MODEL?.trim();

function hasAutoConfigEnvVars() {
  // Need at least one AI API key to auto-configure
  const hasKey = !!(AUTO_CONFIG_ANTHROPIC_KEY || AUTO_CONFIG_OPENAI_KEY || AUTO_CONFIG_GOOGLE_KEY || AUTO_CONFIG_DEEPSEEK_KEY || AUTO_CONFIG_OPENROUTER_KEY || AUTO_CONFIG_CLAWROUTERS_KEY);
  console.log(`[auto-config] env check: TELEGRAM=${!!AUTO_CONFIG_TELEGRAM_TOKEN} ANTHROPIC=${!!AUTO_CONFIG_ANTHROPIC_KEY} OPENAI=${!!AUTO_CONFIG_OPENAI_KEY} GOOGLE=${!!AUTO_CONFIG_GOOGLE_KEY} DEEPSEEK=${!!AUTO_CONFIG_DEEPSEEK_KEY} OPENROUTER=${!!AUTO_CONFIG_OPENROUTER_KEY} CLAWROUTERS=${!!AUTO_CONFIG_CLAWROUTERS_KEY} hasKey=${hasKey}`);
  return hasKey;
}

/**
 * Idempotently force channels.telegram into managed-hosting mode:
 *   - dmPolicy: "open"  (no pairing code required)
 *   - allowFrom: ["*"]  (required when dmPolicy is "open")
 *   - botToken pulled from env
 *   - plugins.entries.telegram: { enabled: true }
 *
 * Runs on EVERY container start when TELEGRAM_BOT_TOKEN is present, regardless
 * of whether openclaw.json already exists. This prevents the previous bug where
 * a re-deploy on an existing volume left the config in its old (potentially
 * "pairing") state because autoConfigureFromEnv() short-circuits on isConfigured().
 */
async function setChannelConfig(name, cfgObj) {
  const r1 = await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "--json", `channels.${name}`, JSON.stringify(cfgObj),
  ]));
  console.log(`[reconcile] channels.${name} exit=${r1.code}`);
  if (r1.output) console.log(r1.output);

  const r2 = await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "--json", `plugins.entries.${name}`, '{"enabled":true}',
  ]));
  console.log(`[reconcile] plugins.entries.${name} exit=${r2.code}`);
  if (r2.output) console.log(r2.output);
}

// Wipe the pairing-store files for token-based channels so a pending
// pairing request left over from an earlier 'pairing' deploy mode can't
// short-circuit our 'open' dmPolicy. OpenClaw consults <channel>-pairing.json
// before honoring config-level dmPolicy: once an approve request is queued,
// the bot keeps asking for `openclaw pairing approve` until that file is
// cleared, even if dmPolicy is now "open" and allowFrom is ["*"].
// QR-paired channels (whatsapp/wechat) store their session in auth-dir and
// must NOT have these files touched — that would force a re-scan.
function clearPairingStore(channelName) {
  const credDir = path.join(STATE_DIR, "credentials");
  for (const suffix of ["pairing.json", "allowFrom.json"]) {
    const f = path.join(credDir, `${channelName}-${suffix}`);
    try {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
        console.log(`[reconcile] cleared ${f}`);
      }
    } catch (err) {
      console.warn(`[reconcile] failed to clear ${f}: ${err.message}`);
    }
  }
}

async function reconcileTelegramChannel() {
  if (!AUTO_CONFIG_TELEGRAM_TOKEN) return;
  console.log("[reconcile] forcing channels.telegram → dmPolicy=open, allowFrom=['*']");
  clearPairingStore("telegram");
  await setChannelConfig("telegram", {
    enabled: true,
    dmPolicy: "open",          // No pairing required — managed-hosting default
    allowFrom: ["*"],          // Required when dmPolicy is "open"
    botToken: AUTO_CONFIG_TELEGRAM_TOKEN,
    groupPolicy: "allowlist",
    // OpenClaw schema coerces this to `streaming` field name internally; both work.
    streamMode: "partial",
  });
}

async function reconcileDiscordChannel() {
  if (!AUTO_CONFIG_DISCORD_TOKEN) return;
  console.log("[reconcile] forcing channels.discord → dm.policy=open, allowFrom=['*']");
  clearPairingStore("discord");
  await setChannelConfig("discord", {
    enabled: true,
    token: AUTO_CONFIG_DISCORD_TOKEN,
    dm: { policy: "open" },
    allowFrom: ["*"],
    groupPolicy: "allowlist",
  });
}

async function reconcileFeishuChannel() {
  if (!AUTO_CONFIG_FEISHU_APP_ID || !AUTO_CONFIG_FEISHU_APP_SECRET) return;
  console.log("[reconcile] forcing channels.feishu → dmPolicy=open, allowFrom=['*']");
  clearPairingStore("feishu");
  await setChannelConfig("feishu", {
    enabled: true,
    appId: AUTO_CONFIG_FEISHU_APP_ID,
    appSecret: AUTO_CONFIG_FEISHU_APP_SECRET,
    dmPolicy: "open",
    allowFrom: ["*"],
  });
}

// WhatsApp uses QR pairing — env flag only enables the channel; the user
// completes pairing through the dashboard after the gateway starts.
async function reconcileWhatsappChannel() {
  if (!AUTO_CONFIG_WHATSAPP_ENABLED) return;
  console.log("[reconcile] enabling channels.whatsapp (QR pairing happens at runtime)");
  await setChannelConfig("whatsapp", {
    enabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
  });
}

// WeChat ships as a separate plugin (@tencent-weixin/openclaw-weixin); like
// WhatsApp it requires QR pairing at runtime.
async function reconcileWechatChannel() {
  if (!AUTO_CONFIG_WECHAT_ENABLED) return;
  console.log("[reconcile] enabling channels.wechat (QR pairing happens at runtime)");
  await setChannelConfig("wechat", {
    enabled: true,
    dmPolicy: "open",
    allowFrom: ["*"],
  });
}

async function reconcileAllChannels() {
  await reconcileTelegramChannel();
  await reconcileDiscordChannel();
  await reconcileFeishuChannel();
  await reconcileWhatsappChannel();
  await reconcileWechatChannel();
}

function hasAnyChannelConfig() {
  return !!(
    AUTO_CONFIG_TELEGRAM_TOKEN ||
    AUTO_CONFIG_DISCORD_TOKEN ||
    (AUTO_CONFIG_FEISHU_APP_ID && AUTO_CONFIG_FEISHU_APP_SECRET) ||
    AUTO_CONFIG_WHATSAPP_ENABLED ||
    AUTO_CONFIG_WECHAT_ENABLED
  );
}

async function autoConfigureFromEnv() {
  if (isConfigured()) {
    console.log("[auto-config] already configured, skipping");
    return true;
  }

  if (!hasAutoConfigEnvVars()) {
    console.log("[auto-config] no API keys in env vars, skipping");
    return false;
  }

  console.log("[auto-config] configuring from environment variables...");

  // Create directories (including credentials dir to avoid CRITICAL doctor warning)
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, "credentials"), { recursive: true });

  // Determine auth choice and secret based on available keys
  let authChoice, authSecret;
  if (AUTO_CONFIG_ANTHROPIC_KEY) {
    authChoice = "apiKey";
    authSecret = AUTO_CONFIG_ANTHROPIC_KEY;
  } else if (AUTO_CONFIG_OPENAI_KEY) {
    authChoice = "openai-api-key";
    authSecret = AUTO_CONFIG_OPENAI_KEY;
  } else if (AUTO_CONFIG_GOOGLE_KEY) {
    authChoice = "gemini-api-key";
    authSecret = AUTO_CONFIG_GOOGLE_KEY;
  } else if (AUTO_CONFIG_DEEPSEEK_KEY) {
    // DeepSeek uses OpenAI-compatible API
    authChoice = "openai-api-key";
    authSecret = AUTO_CONFIG_DEEPSEEK_KEY;
  } else if (AUTO_CONFIG_OPENROUTER_KEY) {
    authChoice = "openrouter-api-key";
    authSecret = AUTO_CONFIG_OPENROUTER_KEY;
  } else if (AUTO_CONFIG_CLAWROUTERS_KEY) {
    // ClawRouters uses OpenAI-compatible API — onboard with it as OpenAI key,
    // then the ClawRouters provider block below overrides the actual routing
    authChoice = "openai-api-key";
    authSecret = AUTO_CONFIG_CLAWROUTERS_KEY;
  }

  const payload = {
    flow: "quickstart",
    authChoice,
    authSecret,
    model: AUTO_CONFIG_DEFAULT_MODEL || "",
  };

  // Use the same buildOnboardArgs logic
  const onboardArgs = buildOnboardArgs(payload);
  console.log("[auto-config] running onboard...");
  const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

  console.log(`[auto-config] onboard exit=${onboard.code}`);
  if (onboard.output) {
    console.log(onboard.output);
  }

  if (onboard.code !== 0 || !isConfigured()) {
    console.error("[auto-config] onboard failed");
    return false;
  }

  // Configure every channel as the FIRST post-onboard step, before gateway
  // settings / model / ClawRouters / image-gen. Each of those subsequent
  // blocks spawns the openclaw CLI which can take a few seconds; if SIGTERM
  // arrives mid-flight (e.g. a fast Railway redeploy), we'd otherwise leave
  // the pairing-store dirty and force the user through the approval flow.
  // Each reconciler is idempotent and no-ops when its env vars are missing.
  await reconcileAllChannels();

  // Configure gateway settings (same as setup wizard)
  console.log("[auto-config] configuring gateway settings...");

  await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "gateway.controlUi.allowInsecureAuth", "true"
  ]));

  await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "gateway.auth.token", OPENCLAW_GATEWAY_TOKEN
  ]));

  await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "--json", "gateway.trustedProxies", '["127.0.0.1"]'
  ]));

  // Allow OneClaw website to connect via WebSocket (Control UI)
  console.log("[auto-config] setting gateway.controlUi.allowedOrigins for OneClaw website...");
  const originsResult = await runCmd(OPENCLAW_NODE, clawArgs([
    "config", "set", "--json", "gateway.controlUi.allowedOrigins", '["https://oneclaw.net","https://www.oneclaw.net"]'
  ]));
  console.log(`[auto-config] allowedOrigins set exit=${originsResult.code}`);
  if (originsResult.output) console.log(originsResult.output);

  // Set model if specified
  if (AUTO_CONFIG_DEFAULT_MODEL) {
    console.log(`[auto-config] setting model to ${AUTO_CONFIG_DEFAULT_MODEL}`);
    await runCmd(OPENCLAW_NODE, clawArgs(["models", "set", AUTO_CONFIG_DEFAULT_MODEL]));
  }

  // Configure ClawRouters if key is provided
  const clawRoutersKey = process.env.CLAWROUTERS_KEY?.trim();
  if (clawRoutersKey) {
    // Route through local proxy when ONECLAW_END_USER is set, so the bot's
    // chat/completions requests get `user: oneclaw_<uid>` injected and
    // ClawRouters can attribute shared-key usage per-user.
    const baseUrl = ONECLAW_END_USER
      ? CR_PROXY_BASE_URL
      : "https://www.clawrouters.com/api/v1";
    console.log(`[auto-config] configuring ClawRouters provider (baseUrl=${baseUrl})...`);
    // Vision (image input): each declared model needs `input: ["text","image"]`
    // so OpenClaw treats inbound photos as native multimodal content instead
    // of running its local OCR/file-path fallback. Without this field the
    // bot replies "I can't see the image" even though the upstream model
    // (Claude / GPT / Gemini) is fully vision-capable.
    const visionModels = [
      { id: "auto",                name: "ClawRouters Auto",     input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
      { id: "claude-sonnet-4.6",   name: "Claude Sonnet 4.6",    input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
      { id: "claude-haiku-4.5",    name: "Claude Haiku 4.5",     input: ["text", "image"], contextWindow: 200000, maxTokens: 8192 },
      { id: "gpt-5.4",             name: "GPT-5.4",              input: ["text", "image"], contextWindow: 1050000, maxTokens: 16384 },
      { id: "gemini-3-pro",        name: "Gemini 3 Pro",         input: ["text", "image"], contextWindow: 1000000, maxTokens: 8192 },
    ];
    const crProvider = {
      baseUrl,
      apiKey: clawRoutersKey,
      api: "openai-completions",
      models: visionModels,
    };
    const crResult = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "--json", "models.providers.clawrouters", JSON.stringify(crProvider)
    ]));
    console.log(`[auto-config] ClawRouters provider exit=${crResult.code}`);

    // Set ClawRouters as the default model
    console.log("[auto-config] setting default model to clawrouters/auto...");
    const modelResult = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "agents.defaults.model.primary", "clawrouters/auto"
    ]));
    console.log(`[auto-config] default model set exit=${modelResult.code}`);

    // Image generation: redirect OpenClaw's built-in `openai` provider at
    // ClawRouters so the image_generate tool calls our /v1/images/generations
    // (DALL-E 3 / GPT-Image-1 / Gemini 3 Flash Image, OpenAI-compatible).
    // OpenClaw resolves `openai/<model>` → POST <baseUrl>/images/generations,
    // which is exactly our endpoint. Means the user's `cr_` key covers chat,
    // vision, AND image gen — no separate OpenAI key required.
    console.log(`[auto-config] redirecting openai provider to ClawRouters for image gen (baseUrl=${baseUrl})...`);
    const openaiOverride = {
      baseUrl,
      apiKey: clawRoutersKey,
    };
    const openaiResult = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "--json", "models.providers.openai", JSON.stringify(openaiOverride)
    ]));
    console.log(`[auto-config] openai provider override exit=${openaiResult.code}`);

    // openai/gpt-image-1 is the only safe choice as of 2026-04-24:
    //   - gpt-image-2 launched 2026-04-21 but API opens "early May 2026"
    //   - dall-e-3 + dall-e-2 retire 2026-05-12 (would be a timed bomb)
    // Leave fallbacks empty rather than wire a model that's about to break;
    // a rebuild can add gpt-image-2 as primary once OpenAI opens API access.
    console.log("[auto-config] enabling image_generate tool with gpt-image-1...");
    const imageGenConfig = {
      primary: "openai/gpt-image-1",
    };
    const imageGenResult = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "--json", "agents.defaults.imageGenerationModel", JSON.stringify(imageGenConfig)
    ]));
    console.log(`[auto-config] image_generate config exit=${imageGenResult.code}`);

    // Disable the skill-based image-gen entries that would otherwise compete
    // with the tool path and require their own OpenAI / Gemini keys (which
    // we don't ship to deployed instances). The tool path above is enough.
    console.log("[auto-config] disabling skill-based image-gen entries...");
    for (const skillKey of ["openai-image-gen", "nano-banana-pro"]) {
      const r = await runCmd(OPENCLAW_NODE, clawArgs([
        "config", "set", "--json", `skills.entries.${skillKey}`, JSON.stringify({ enabled: false })
      ]));
      console.log(`[auto-config] disable ${skillKey} exit=${r.code}`);
    }
  }

  // No doctor --fix needed: channels.telegram + plugins.entries.telegram are both set above.
  // Gateway will activate Telegram automatically on startup.
  console.log("[auto-config] BUILD_ID=v20260424a - vision models + image_generate via ClawRouters");

  // Set ALL available API keys in config (not just the primary one used for onboard)
  // This allows users to switch between providers or use fallback models
  console.log("[auto-config] setting additional API keys in config...");
  const envKeys = {};
  if (AUTO_CONFIG_ANTHROPIC_KEY) {
    envKeys.ANTHROPIC_API_KEY = AUTO_CONFIG_ANTHROPIC_KEY;
    console.log("[auto-config] + ANTHROPIC_API_KEY");
  }
  if (AUTO_CONFIG_OPENAI_KEY) {
    envKeys.OPENAI_API_KEY = AUTO_CONFIG_OPENAI_KEY;
    console.log("[auto-config] + OPENAI_API_KEY");
  }
  if (AUTO_CONFIG_GOOGLE_KEY) {
    envKeys.GOOGLE_GENERATIVE_AI_API_KEY = AUTO_CONFIG_GOOGLE_KEY;
    console.log("[auto-config] + GOOGLE_GENERATIVE_AI_API_KEY");
  }
  if (AUTO_CONFIG_DEEPSEEK_KEY) {
    envKeys.DEEPSEEK_API_KEY = AUTO_CONFIG_DEEPSEEK_KEY;
    console.log("[auto-config] + DEEPSEEK_API_KEY");
  }
  
  // Set all keys at once in the env config
  if (Object.keys(envKeys).length > 0) {
    const envResult = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "--json", "env", JSON.stringify(envKeys)
    ]));
    console.log(`[auto-config] env keys set exit=${envResult.code}`);
    if (envResult.output) {
      console.log(envResult.output);
    }
  }

  console.log("[auto-config] configuration complete!");
  return true;
}

const setupRateLimiter = {
  attempts: new Map(),
  windowMs: 60_000,
  maxAttempts: 50,
  cleanupInterval: setInterval(function () {
    const now = Date.now();
    for (const [ip, data] of setupRateLimiter.attempts) {
      if (now - data.windowStart > setupRateLimiter.windowMs) {
        setupRateLimiter.attempts.delete(ip);
      }
    }
  }, 60_000),

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

function requireSetupAuth(req, res, next) {
  if (!SETUP_PASSWORD) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "SETUP_PASSWORD is not set. Set it in Railway Variables before using /setup.",
      );
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  if (setupRateLimiter.isRateLimited(ip)) {
    return res.status(429).type("text/plain").send("Too many requests. Try again later.");
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Auth required");
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const password = idx >= 0 ? decoded.slice(idx + 1) : "";
  const passwordHash = crypto.createHash("sha256").update(password).digest();
  const expectedHash = crypto.createHash("sha256").update(SETUP_PASSWORD).digest();
  const isValid = crypto.timingSafeEqual(passwordHash, expectedHash);
  if (!isValid) {
    res.set("WWW-Authenticate", 'Basic realm="OpenClaw Setup"');
    return res.status(401).send("Invalid password");
  }
  return next();
}

// ───────────────────────────────────────────────────────────────────────
// ClawRouters loopback proxy — injects `user: ONECLAW_END_USER` into
// every /chat/completions body so shared-key usage can be attributed
// back to the OneClaw end-user. Listens on 127.0.0.1 only (no external
// exposure). Upstream OpenClaw binary is configured to use this proxy
// as its ClawRouters baseUrl when ONECLAW_END_USER is set.
// ───────────────────────────────────────────────────────────────────────
const CR_PROXY_PORT = Number.parseInt(process.env.CR_PROXY_PORT ?? "18791", 10);
const CR_UPSTREAM = "https://www.clawrouters.com";
const CR_PROXY_BASE_URL = `http://127.0.0.1:${CR_PROXY_PORT}/api/v1`;
const ONECLAW_END_USER = process.env.ONECLAW_END_USER?.trim() || "";

// Only inject `user` on these chat/completion endpoints.
// GET /models, POST /files (multipart), POST /embeddings, etc. pass through untouched.
const CR_INJECT_PATHS = [
  "/api/v1/chat/completions",
  "/api/v1/completions",
  "/api/v1/messages",
];

function shouldInjectUser(req) {
  if (req.method !== "POST") return false;
  const urlPath = req.url.split("?")[0];
  if (!CR_INJECT_PATHS.some((p) => urlPath === p || urlPath.endsWith(p))) return false;
  // Content-Type must be JSON — never touch multipart/form-data, binary, etc.
  const ct = (req.headers["content-type"] || "").toLowerCase();
  if (!ct.includes("application/json")) return false;
  // Body must be a non-empty object successfully parsed by express.json().
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) return false;
  if (Object.keys(req.body).length === 0) return false;
  return true;
}

function startClawRoutersProxy() {
  if (!ONECLAW_END_USER) {
    console.log("[cr-proxy] ONECLAW_END_USER not set, skipping proxy");
    return null;
  }

  const proxy = httpProxy.createProxyServer({
    target: CR_UPSTREAM,
    changeOrigin: true,
    secure: true,
    selfHandleResponse: false,
    // Long enough for slow streaming completions; short enough to surface stuck connections.
    proxyTimeout: 180_000,
    timeout: 180_000,
  });

  // Inject `user` into JSON bodies only on whitelisted chat endpoints.
  proxy.on("proxyReq", (proxyReq, req) => {
    if (!shouldInjectUser(req)) return;
    if (req.body.user) return; // caller already set it — respect it

    const bodyStr = JSON.stringify({ ...req.body, user: ONECLAW_END_USER });
    proxyReq.setHeader("Content-Type", "application/json");
    proxyReq.setHeader("Content-Length", Buffer.byteLength(bodyStr));
    proxyReq.write(bodyStr);
  });

  proxy.on("error", (err, _req, res) => {
    console.error("[cr-proxy] upstream error:", err.message);
    if (res && typeof res.writeHead === "function" && !res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad gateway", detail: err.message }));
    }
  });

  const proxyApp = express();
  // Parse JSON bodies up to 20MB; non-JSON bodies are left as raw streams that pass through.
  proxyApp.use(express.json({ limit: "20mb" }));
  proxyApp.use((req, res) => {
    proxy.web(req, res);
  });

  proxyApp
    .listen(CR_PROXY_PORT, "127.0.0.1", () => {
      console.log(
        `[cr-proxy] listening on ${CR_PROXY_BASE_URL} → ${CR_UPSTREAM} (inject user=${ONECLAW_END_USER} on ${CR_INJECT_PATHS.join(", ")})`,
      );
    })
    .on("error", (err) => {
      // Proxy bind failure must NOT crash the main server. Upstream openclaw will
      // try to connect to the loopback URL and get ECONNREFUSED — that's a degraded
      // state but at least the instance boots.
      console.error(`[cr-proxy] failed to bind ${CR_PROXY_PORT}:`, err.message);
    });
}

startClawRoutersProxy();

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/setup/healthz", (_req, res) => res.json({ ok: true }));

// Fix webchat config endpoint (uses gateway token for auth)
app.post("/api/fix-webchat", async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  
  if (!OPENCLAW_GATEWAY_TOKEN || token !== OPENCLAW_GATEWAY_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!isConfigured()) {
    return res.status(400).json({ error: 'Instance not configured' });
  }

  try {
    console.log("[fix-webchat] applying webchat config fixes...");
    
    // Set allowInsecureAuth
    const authResult = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "gateway.controlUi.allowInsecureAuth", "true"
    ]));
    
    // Set allowedOrigins
    const originsResult = await runCmd(OPENCLAW_NODE, clawArgs([
      "config", "set", "--json", "gateway.controlUi.allowedOrigins", 
      '["https://oneclaw.net","https://www.oneclaw.net"]'
    ]));

    console.log(`[fix-webchat] done: allowInsecureAuth=${authResult.code} allowedOrigins=${originsResult.code}`);
    
    return res.json({ 
      ok: true, 
      message: 'Webchat config applied',
      results: {
        allowInsecureAuth: authResult.code === 0,
        allowedOrigins: originsResult.code === 0
      }
    });
  } catch (err) {
    console.error("[fix-webchat] error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// OneClaw test message endpoint
app.post("/api/test", async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  
  if (!ONECLAW_INSTANCE_SECRET || token !== ONECLAW_INSTANCE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { type, message } = req.body || {};
  
  if (type === 'test') {
    // Log the test and respond
    console.log(`[test] received test message: ${message}`);
    trackMessage(0, null); // Track as a message for stats
    return res.json({ 
      ok: true, 
      message: 'Test received',
      instanceId: ONECLAW_INSTANCE_ID,
      status: isGatewayReady() ? 'healthy' : 'starting',
    });
  }

  return res.json({ ok: true });
});

// OneClaw personality sync endpoint (webhook from dashboard)
app.post("/api/personality/sync", async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  
  if (!ONECLAW_INSTANCE_SECRET || token !== ONECLAW_INSTANCE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { personality, template } = await fetchPersonality();
    if (personality || template) {
      await applyPersonality(personality, template);
      return res.json({ ok: true, message: 'Personality synced' });
    }
    return res.json({ ok: true, message: 'No personality to sync' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/setup/styles.css", (_req, res) => {
  res.type("text/css");
  res.sendFile(path.join(process.cwd(), "src", "public", "styles.css"));
});

app.get("/setup", requireSetupAuth, (_req, res) => {
  res.sendFile(path.join(process.cwd(), "src", "public", "setup.html"));
});

app.get("/setup/api/status", requireSetupAuth, async (_req, res) => {
  const { version, channelsHelp } = await getOpenclawInfo();

  const authGroups = [
    {
      value: "openai",
      label: "OpenAI",
      hint: "Codex OAuth + API key",
      options: [
        { value: "codex-cli", label: "OpenAI Codex OAuth (Codex CLI)" },
        { value: "openai-codex", label: "OpenAI Codex (ChatGPT OAuth)" },
        { value: "openai-api-key", label: "OpenAI API key" },
      ],
    },
    {
      value: "anthropic",
      label: "Anthropic",
      hint: "Claude Code CLI + API key",
      options: [
        { value: "claude-cli", label: "Anthropic token (Claude Code CLI)" },
        { value: "token", label: "Anthropic token (paste setup-token)" },
        { value: "apiKey", label: "Anthropic API key" },
      ],
    },
    {
      value: "google",
      label: "Google",
      hint: "Gemini API key + OAuth",
      options: [
        { value: "gemini-api-key", label: "Google Gemini API key" },
        { value: "google-antigravity", label: "Google Antigravity OAuth" },
        { value: "google-gemini-cli", label: "Google Gemini CLI OAuth" },
      ],
    },
    {
      value: "openrouter",
      label: "OpenRouter",
      hint: "API key",
      options: [{ value: "openrouter-api-key", label: "OpenRouter API key" }],
    },
    {
      value: "ai-gateway",
      label: "Vercel AI Gateway",
      hint: "API key",
      options: [
        { value: "ai-gateway-api-key", label: "Vercel AI Gateway API key" },
      ],
    },
    {
      value: "moonshot",
      label: "Moonshot AI",
      hint: "Kimi K2 + Kimi Code",
      options: [
        { value: "moonshot-api-key", label: "Moonshot AI API key" },
        { value: "kimi-code-api-key", label: "Kimi Code API key" },
      ],
    },
    {
      value: "zai",
      label: "Z.AI (GLM 4.7)",
      hint: "API key",
      options: [{ value: "zai-api-key", label: "Z.AI (GLM 4.7) API key" }],
    },
    {
      value: "minimax",
      label: "MiniMax",
      hint: "M2.1 (recommended)",
      options: [
        { value: "minimax-api", label: "MiniMax M2.1" },
        { value: "minimax-api-lightning", label: "MiniMax M2.1 Lightning" },
      ],
    },
    {
      value: "qwen",
      label: "Qwen",
      hint: "OAuth",
      options: [{ value: "qwen-portal", label: "Qwen OAuth" }],
    },
    {
      value: "copilot",
      label: "Copilot",
      hint: "GitHub + local proxy",
      options: [
        {
          value: "github-copilot",
          label: "GitHub Copilot (GitHub device login)",
        },
        { value: "copilot-proxy", label: "Copilot Proxy (local)" },
      ],
    },
    {
      value: "synthetic",
      label: "Synthetic",
      hint: "Anthropic-compatible (multi-model)",
      options: [{ value: "synthetic-api-key", label: "Synthetic API key" }],
    },
    {
      value: "opencode-zen",
      label: "OpenCode Zen",
      hint: "API key",
      options: [
        { value: "opencode-zen", label: "OpenCode Zen (multi-model proxy)" },
      ],
    },
  ];

  res.json({
    configured: isConfigured(),
    gatewayTarget: GATEWAY_TARGET,
    openclawVersion: version,
    channelsAddHelp: channelsHelp,
    authGroups,
    tuiEnabled: ENABLE_WEB_TUI,
  });
});

function buildOnboardArgs(payload) {
  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--json",
    "--no-install-daemon",
    "--skip-health",
    "--workspace",
    WORKSPACE_DIR,
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(INTERNAL_GATEWAY_PORT),
    "--gateway-auth",
    "token",
    "--gateway-token",
    OPENCLAW_GATEWAY_TOKEN,
    "--flow",
    payload.flow || "quickstart",
  ];

  if (payload.authChoice) {
    args.push("--auth-choice", payload.authChoice);

    const secret = (payload.authSecret || "").trim();
    const map = {
      "openai-api-key": "--openai-api-key",
      apiKey: "--anthropic-api-key",
      "openrouter-api-key": "--openrouter-api-key",
      "ai-gateway-api-key": "--ai-gateway-api-key",
      "moonshot-api-key": "--moonshot-api-key",
      "kimi-code-api-key": "--kimi-code-api-key",
      "gemini-api-key": "--gemini-api-key",
      "zai-api-key": "--zai-api-key",
      "minimax-api": "--minimax-api-key",
      "minimax-api-lightning": "--minimax-api-key",
      "synthetic-api-key": "--synthetic-api-key",
      "opencode-zen": "--opencode-zen-api-key",
    };
    const flag = map[payload.authChoice];
    if (flag && secret) {
      args.push(flag, secret);
    }

    if (payload.authChoice === "token" && secret) {
      args.push("--token-provider", "anthropic", "--token", secret);
    }
  }

  return args;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const proc = childProcess.spawn(cmd, args, {
      ...opts,
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: STATE_DIR,
        OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
      },
    });

    let out = "";
    proc.stdout?.on("data", (d) => (out += d.toString("utf8")));
    proc.stderr?.on("data", (d) => (out += d.toString("utf8")));

    proc.on("error", (err) => {
      out += `\n[spawn error] ${String(err)}\n`;
      resolve({ code: 127, output: out });
    });

    proc.on("close", (code) => resolve({ code: code ?? 0, output: out }));
  });
}

const VALID_FLOWS = ["quickstart", "advanced", "manual"];
const VALID_AUTH_CHOICES = [
  "codex-cli",
  "openai-codex",
  "openai-api-key",
  "claude-cli",
  "token",
  "apiKey",
  "gemini-api-key",
  "google-antigravity",
  "google-gemini-cli",
  "openrouter-api-key",
  "ai-gateway-api-key",
  "moonshot-api-key",
  "kimi-code-api-key",
  "zai-api-key",
  "minimax-api",
  "minimax-api-lightning",
  "qwen-portal",
  "github-copilot",
  "copilot-proxy",
  "synthetic-api-key",
  "opencode-zen",
];

function validatePayload(payload) {
  if (payload.flow && !VALID_FLOWS.includes(payload.flow)) {
    return `Invalid flow: ${payload.flow}. Must be one of: ${VALID_FLOWS.join(", ")}`;
  }
  if (payload.authChoice && !VALID_AUTH_CHOICES.includes(payload.authChoice)) {
    return `Invalid authChoice: ${payload.authChoice}`;
  }
  const stringFields = [
    "telegramToken",
    "discordToken",
    "slackBotToken",
    "slackAppToken",
    "authSecret",
    "model",
  ];
  for (const field of stringFields) {
    if (payload[field] !== undefined && typeof payload[field] !== "string") {
      return `Invalid ${field}: must be a string`;
    }
  }
  return null;
}

app.post("/setup/api/run", requireSetupAuth, async (req, res) => {
  try {
    if (isConfigured()) {
      await ensureGatewayRunning();
      return res.json({
        ok: true,
        output:
          "Already configured.\nUse Reset setup if you want to rerun onboarding.\n",
      });
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.mkdirSync(WORKSPACE_DIR, { recursive: true });

    const payload = req.body || {};
    const validationError = validatePayload(payload);
    if (validationError) {
      return res.status(400).json({ ok: false, output: validationError });
    }
    const onboardArgs = buildOnboardArgs(payload);
    const onboard = await runCmd(OPENCLAW_NODE, clawArgs(onboardArgs));

    let extra = "";
    extra += `\n[setup] Onboarding exit=${onboard.code} configured=${isConfigured()}\n`;

    const ok = onboard.code === 0 && isConfigured();

    if (ok) {
      extra += "\n[setup] Configuring gateway settings...\n";

      const allowInsecureResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.controlUi.allowInsecureAuth",
          "true",
        ]),
      );
      extra += `[config] gateway.controlUi.allowInsecureAuth=true exit=${allowInsecureResult.code}\n`;

      const tokenResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "gateway.auth.token",
          OPENCLAW_GATEWAY_TOKEN,
        ]),
      );
      extra += `[config] gateway.auth.token exit=${tokenResult.code}\n`;

      const proxiesResult = await runCmd(
        OPENCLAW_NODE,
        clawArgs([
          "config",
          "set",
          "--json",
          "gateway.trustedProxies",
          '["127.0.0.1"]',
        ]),
      );
      extra += `[config] gateway.trustedProxies exit=${proxiesResult.code}\n`;

      // Set allowed origins for Control UI WebSocket connections
      const setupAllowedOrigins = process.env.GATEWAY_CONTROL_UI_ALLOWED_ORIGINS?.trim();
      if (setupAllowedOrigins) {
        const originsArray = setupAllowedOrigins.split(',').map(o => o.trim()).filter(Boolean);
        const originsResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            "gateway.controlUi.allowedOrigins",
            JSON.stringify(originsArray),
          ]),
        );
        extra += `[config] gateway.controlUi.allowedOrigins exit=${originsResult.code}\n`;
      }

      if (payload.model?.trim()) {
        extra += `[setup] Setting model to ${payload.model.trim()}...\n`;
        const modelResult = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["models", "set", payload.model.trim()]),
        );
        extra += `[models set] exit=${modelResult.code}\n${modelResult.output || ""}`;
      }

      const channelsHelp = await runCmd(
        OPENCLAW_NODE,
        clawArgs(["channels", "add", "--help"]),
      );
      const helpText = channelsHelp.output || "";

      async function configureChannel(name, cfgObj) {
        if (!helpText.includes(name)) {
          return `\n[${name}] skipped (this openclaw build does not list ${name} in \`channels add --help\`)\n`;
        }
        const set = await runCmd(
          OPENCLAW_NODE,
          clawArgs([
            "config",
            "set",
            "--json",
            `channels.${name}`,
            JSON.stringify(cfgObj),
          ]),
        );
        const get = await runCmd(
          OPENCLAW_NODE,
          clawArgs(["config", "get", `channels.${name}`]),
        );
        return (
          `\n[${name} config] exit=${set.code} (output ${set.output.length} chars)\n${set.output || "(no output)"}` +
          `\n[${name} verify] exit=${get.code} (output ${get.output.length} chars)\n${get.output || "(no output)"}`
        );
      }

      if (payload.telegramToken?.trim()) {
        extra += await configureChannel("telegram", {
          enabled: true,
          dmPolicy: "pairing",
          botToken: payload.telegramToken.trim(),
          groupPolicy: "allowlist",
          streamMode: "partial",
        });
      }

      if (payload.discordToken?.trim()) {
        extra += await configureChannel("discord", {
          enabled: true,
          token: payload.discordToken.trim(),
          groupPolicy: "allowlist",
          dm: { policy: "pairing" },
        });
      }

      if (payload.slackBotToken?.trim() || payload.slackAppToken?.trim()) {
        extra += await configureChannel("slack", {
          enabled: true,
          botToken: payload.slackBotToken?.trim() || undefined,
          appToken: payload.slackAppToken?.trim() || undefined,
        });
      }

      extra += "\n[setup] Starting gateway...\n";
      await restartGateway();
      extra += "[setup] Gateway started.\n";
    }

    return res.status(ok ? 200 : 500).json({
      ok,
      output: `${onboard.output}${extra}`,
    });
  } catch (err) {
    console.error("[/setup/api/run] error:", err);
    return res
      .status(500)
      .json({ ok: false, output: `Internal error: ${String(err)}` });
  }
});

app.get("/setup/api/debug", requireSetupAuth, async (_req, res) => {
  const v = await runCmd(OPENCLAW_NODE, clawArgs(["--version"]));
  const help = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["channels", "add", "--help"]),
  );
  res.json({
    wrapper: {
      node: process.version,
      port: PORT,
      stateDir: STATE_DIR,
      workspaceDir: WORKSPACE_DIR,
      configPath: configPath(),
      gatewayTokenFromEnv: Boolean(process.env.OPENCLAW_GATEWAY_TOKEN?.trim()),
      gatewayTokenPersisted: fs.existsSync(
        path.join(STATE_DIR, "gateway.token"),
      ),
      railwayCommit: process.env.RAILWAY_GIT_COMMIT_SHA || null,
    },
    openclaw: {
      entry: OPENCLAW_ENTRY,
      node: OPENCLAW_NODE,
      version: v.output.trim(),
      channelsAddHelpIncludesTelegram: help.output.includes("telegram"),
    },
  });
});

app.post("/setup/api/pairing/approve", requireSetupAuth, async (req, res) => {
  const { channel, code } = req.body || {};
  if (!channel || !code) {
    return res
      .status(400)
      .json({ ok: false, error: "Missing channel or code" });
  }
  const r = await runCmd(
    OPENCLAW_NODE,
    clawArgs(["pairing", "approve", String(channel), String(code)]),
  );
  return res
    .status(r.code === 0 ? 200 : 500)
    .json({ ok: r.code === 0, output: r.output });
});

app.post("/setup/api/reset", requireSetupAuth, async (_req, res) => {
  try {
    fs.rmSync(configPath(), { force: true });
    res
      .type("text/plain")
      .send("OK - deleted config file. You can rerun setup now.");
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});

app.post("/setup/api/doctor", requireSetupAuth, async (_req, res) => {
  const args = ["doctor", "--non-interactive", "--repair"];
  const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
  return res.status(result.code === 0 ? 200 : 500).json({
    ok: result.code === 0,
    output: result.output,
  });
});

app.get("/tui", requireSetupAuth, (_req, res) => {
  if (!ENABLE_WEB_TUI) {
    return res
      .status(403)
      .type("text/plain")
      .send("Web TUI is disabled. Set ENABLE_WEB_TUI=true to enable it.");
  }
  if (!isConfigured()) {
    return res.redirect("/setup");
  }
  res.sendFile(path.join(process.cwd(), "src", "public", "tui.html"));
});

let activeTuiSession = null;

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

function createTuiWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    const clientIp = req.socket?.remoteAddress || "unknown";
    console.log(`[tui] session started from ${clientIp}`);

    let ptyProcess = null;
    let idleTimer = null;
    let maxSessionTimer = null;

    activeTuiSession = {
      ws,
      pty: null,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };

    function resetIdleTimer() {
      if (activeTuiSession) {
        activeTuiSession.lastActivity = Date.now();
      }
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);
    }

    function spawnPty(cols, rows) {
      if (ptyProcess) return;

      console.log(`[tui] spawning PTY with ${cols}x${rows}`);
      ptyProcess = pty.spawn(OPENCLAW_NODE, clawArgs(["tui"]), {
        name: "xterm-256color",
        cols,
        rows,
        cwd: WORKSPACE_DIR,
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: STATE_DIR,
          OPENCLAW_WORKSPACE_DIR: WORKSPACE_DIR,
          TERM: "xterm-256color",
        },
      });

      if (activeTuiSession) {
        activeTuiSession.pty = ptyProcess;
      }

      idleTimer = setTimeout(() => {
        console.log("[tui] session idle timeout");
        ws.close(4002, "Idle timeout");
      }, TUI_IDLE_TIMEOUT_MS);

      maxSessionTimer = setTimeout(() => {
        console.log("[tui] max session duration reached");
        ws.close(4002, "Max session duration");
      }, TUI_MAX_SESSION_MS);

      ptyProcess.onData((data) => {
        if (ws.readyState === ws.OPEN) {
          ws.send(data);
        }
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[tui] PTY exited code=${exitCode} signal=${signal}`);
        if (ws.readyState === ws.OPEN) {
          ws.close(1000, "Process exited");
        }
      });
    }

    ws.on("message", (message) => {
      resetIdleTimer();
      try {
        const msg = JSON.parse(message.toString());
        if (msg.type === "resize" && msg.cols && msg.rows) {
          const cols = Math.min(Math.max(msg.cols, 10), 500);
          const rows = Math.min(Math.max(msg.rows, 5), 200);
          if (!ptyProcess) {
            spawnPty(cols, rows);
          } else {
            ptyProcess.resize(cols, rows);
          }
        } else if (msg.type === "input" && msg.data && ptyProcess) {
          ptyProcess.write(msg.data);
        }
      } catch (err) {
        console.warn(`[tui] invalid message: ${err.message}`);
      }
    });

    ws.on("close", () => {
      console.log("[tui] session closed");
      clearTimeout(idleTimer);
      clearTimeout(maxSessionTimer);
      if (ptyProcess) {
        try {
          ptyProcess.kill();
        } catch {}
      }
      activeTuiSession = null;
    });

    ws.on("error", (err) => {
      console.error(`[tui] WebSocket error: ${err.message}`);
    });
  });

  return wss;
}

const proxy = httpProxy.createProxyServer({
  target: GATEWAY_TARGET,
  ws: true,
  xfwd: true,
});

proxy.on("error", (err, _req, _res) => {
  console.error("[proxy]", err);
});

proxy.on("proxyReq", (proxyReq, req, res) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

proxy.on("proxyReqWs", (proxyReq, req, socket, options, head) => {
  proxyReq.setHeader("Authorization", `Bearer ${OPENCLAW_GATEWAY_TOKEN}`);
});

app.use(async (req, res) => {
  if (!isConfigured() && !req.path.startsWith("/setup")) {
    return res.redirect("/setup");
  }

  if (isConfigured()) {
    if (isGatewayStarting() && !isGatewayReady()) {
      return res.sendFile(path.join(process.cwd(), "src", "public", "loading.html"));
    }

    try {
      await ensureGatewayRunning();
    } catch (err) {
      return res
        .status(503)
        .type("text/plain")
        .send(`Gateway not ready: ${String(err)}`);
    }
  }

  if (req.path === "/openclaw" && !req.query.token) {
    return res.redirect(`/openclaw?token=${OPENCLAW_GATEWAY_TOKEN}`);
  }

  return proxy.web(req, res, { target: GATEWAY_TARGET });
});

const server = app.listen(PORT, async () => {
  console.log(`[wrapper] listening on port ${PORT}`);
  console.log(`[wrapper] setup wizard: http://localhost:${PORT}/setup`);
  console.log(`[wrapper] web TUI: ${ENABLE_WEB_TUI ? "enabled" : "disabled"}`);
  console.log(`[wrapper] OneClaw heartbeat: ${ONECLAW_INSTANCE_ID ? "enabled" : "disabled"}`);

  // Start heartbeat reporting to OneClaw
  if (ONECLAW_INSTANCE_ID) {
    startHeartbeat();
  }

  // Re-deploy reconciliation: even when openclaw.json already exists (re-deploys
  // on a persisted Railway volume), force every configured channel into the
  // right state so users never see a pairing prompt because of a stale openclaw.json.
  //
  // Run this BEFORE ensureGatewayRunning() below so the first inbound message
  // is handled with dmPolicy=open, not whatever stale config was on disk.
  // Previously this was a setTimeout that raced the gateway startup and let a
  // single early Telegram update get queued as a pending pairing request.
  if (isConfigured() && hasAnyChannelConfig()) {
    console.log("[wrapper] already configured — running channel reconcile pass");
    try {
      await reconcileAllChannels();
      console.log("[wrapper] reconcile complete; gateway will boot with fresh config");
    } catch (err) {
      console.error(`[wrapper] reconcile failed: ${err.message}`);
    }
  }

  // Auto-configure from environment variables if not already configured
  // Run in background to not block health check
  if (!isConfigured() && hasAutoConfigEnvVars()) {
    console.log("[wrapper] scheduling auto-configuration from env vars...");
    setTimeout(async () => {
      try {
        console.log("[wrapper] starting auto-configuration...");
        const success = await autoConfigureFromEnv();
        console.log(`[wrapper] auto-config ${success ? "succeeded" : "failed"}`);
        console.log(`[wrapper] configured: ${isConfigured()}`);
        if (isConfigured()) {
          // Apply template from env var before starting gateway
          if (ONECLAW_TEMPLATE_ID) {
            await applyTemplateFromEnv();
          }
          
          // Ensure WebSocket config is correct (critical for web chat)
          await ensureWebSocketConfig();
          
          ensureGatewayRunning().then(async () => {
            // No doctor --fix needed. Both channels.telegram and plugins.entries.telegram
            // are configured before gateway starts, so Telegram activates automatically.
            console.log("[wrapper] gateway started successfully after auto-config");
          }).catch((err) => {
            console.error(`[wrapper] failed to start gateway after auto-config: ${err.message}`);
          });
        }
      } catch (err) {
        console.error(`[wrapper] auto-config failed: ${err.message}`);
      }
    }, 1000); // Start after 1 second to let health check pass first
  }

  console.log(`[wrapper] configured: ${isConfigured()}`);

  if (isConfigured()) {
    // Apply template from env var before starting gateway
    if (ONECLAW_TEMPLATE_ID) {
      await applyTemplateFromEnv();
    }
    
    // Ensure WebSocket config is correct (fixes existing instances)
    await ensureWebSocketConfig();
    
    ensureGatewayRunning().then(async () => {
      console.log("[wrapper] gateway started successfully at boot");
    }).catch((err) => {
      console.error(`[wrapper] failed to start gateway at boot: ${err.message}`);
    });
  }
});

const tuiWss = createTuiWebSocketServer(server);

server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/tui/ws") {
    if (!ENABLE_WEB_TUI) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!verifyTuiAuth(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"OpenClaw TUI\"\r\n\r\n");
      socket.destroy();
      return;
    }

    if (activeTuiSession) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      return;
    }

    tuiWss.handleUpgrade(req, socket, head, (ws) => {
      tuiWss.emit("connection", ws, req);
    });
    return;
  }

  if (!isConfigured()) {
    socket.destroy();
    return;
  }
  try {
    await ensureGatewayRunning();
  } catch (err) {
    console.warn(`[websocket] gateway not ready: ${err.message}`);
    socket.destroy();
    return;
  }
  proxy.ws(req, socket, head, { target: GATEWAY_TARGET });
});

async function gracefulShutdown(signal) {
  console.log(`[wrapper] received ${signal}, shutting down`);

  // Stop heartbeat and send shutdown event
  stopHeartbeat();
  await sendEvent('instance_stopping', { signal });

  if (setupRateLimiter.cleanupInterval) {
    clearInterval(setupRateLimiter.cleanupInterval);
  }

  if (activeTuiSession) {
    try {
      activeTuiSession.ws.close(1001, "Server shutting down");
      activeTuiSession.pty.kill();
    } catch {}
    activeTuiSession = null;
  }

  server.close();

  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => gatewayProc.on("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (gatewayProc && !gatewayProc.killed) {
        gatewayProc.kill("SIGKILL");
      }
    } catch (err) {
      console.warn(`[wrapper] error killing gateway: ${err.message}`);
    }
  }

  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// Build timestamp: 1770185637
