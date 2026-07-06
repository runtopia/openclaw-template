// OneClaw platform integration.

import fs from "node:fs";
import path from "node:path";

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 小时
const REMINDERS_CHECK_INTERVAL_MS = 60 * 1000;

export function normalizeOneclawApiUrl(raw) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (base.endsWith("/api/v1")) return base;
  if (base.endsWith("/api")) return `${base}/v1`;
  return `${base}/api/v1`;
}

export function createOneclawIntegration({
  apiUrl, instanceId, instanceSecret, workspaceDir,
  gatewayTarget, gatewayToken, isGatewayReady, isGatewayStarting,
}) {
  const platformApiUrl = normalizeOneclawApiUrl(apiUrl);
  if (!platformApiUrl || !instanceId || !instanceSecret) {
    return {
      start() {},
      stop() {},
      sendHeartbeat() {},
      sendEvent() {},
      trackMessage() {},
      getCachedPersonality() { return null; },
      fetchPersonality() { return Promise.resolve({ personality: null, template: null }); },
      applyPersonality() { return Promise.resolve(); },
      applyTemplateFromEnv() { return Promise.resolve(false); },
    };
  }

  let heartbeatInterval = null;
  let remindersInterval = null;
  let cachedPersonality = null;
  const usageStats = { messages: 0, tokens: 0, lastModel: null };

  function trackMessage(tokens = 0, model = null) {
    usageStats.messages++;
    usageStats.tokens += tokens;
    if (model) usageStats.lastModel = model;
  }

  async function apiFetch(endpoint, opts = {}) {
    return fetch(`${platformApiUrl}${endpoint}`, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${instanceSecret}`, ...(opts.headers || {}) },
    });
  }

  async function sendEvent(event, data = {}) {
    try {
      await apiFetch("/agent/event", {
        method: "POST",
        body: JSON.stringify({ instance_id: instanceId, event, data, timestamp: new Date().toISOString() }),
      });
      console.log(`[event] sent: ${event}`);
    } catch (err) {
      console.error(`[event] error: ${err.message}`);
    }
  }

  async function reportStats() {
    if (usageStats.messages === 0) return;
    try {
      const res = await apiFetch("/agent/stats", {
        method: "POST",
        body: JSON.stringify({ instance_id: instanceId, secret: instanceSecret, messages: usageStats.messages, tokens: usageStats.tokens, model: usageStats.lastModel }),
      });
      if (res.ok) {
        console.log(`[stats] reported: ${usageStats.messages} messages`);
        usageStats.messages = 0;
        usageStats.tokens = 0;
      }
    } catch (err) {
      console.error(`[stats] error: ${err.message}`);
    }
  }

  async function fetchPersonality() {
    try {
      const res = await apiFetch(`/agent/personality?instance_id=${encodeURIComponent(instanceId)}`, { method: "GET" });
      if (res.ok) {
        const data = await res.json();
        cachedPersonality = normalizePersonality(data.personality);
        console.log(`[personality] fetched: ${cachedPersonality?.botName || "default"}`);
        return { personality: cachedPersonality, template: normalizeTemplate(data.template) };
      }
    } catch (err) {
      console.error(`[personality] fetch error: ${err.message}`);
    }
    return { personality: null, template: null };
  }

  async function applyPersonality(personality, template = null) {
    try {
      const systemPrompt = personality?.systemPrompt || personality?.system_prompt;
      if (systemPrompt) {
        const soulPath = path.join(workspaceDir, "SOUL.md");
        fs.mkdirSync(workspaceDir, { recursive: true });
        fs.writeFileSync(soulPath, systemPrompt, "utf8");
        console.log(`[personality] applied system prompt`);
      }
      applyMemoryFiles(template?.memoryFiles || template?.memory_files);
    } catch (err) {
      console.error(`[personality] apply error: ${err.message}`);
    }
  }

  async function applyTemplateFromEnv(templateId) {
    if (!templateId) return false;
    const soulPath = path.join(workspaceDir, "SOUL.md");
    if (fs.existsSync(soulPath) && fs.readFileSync(soulPath, "utf8").length > 100) {
      console.log("[template] SOUL.md already exists, skipping");
      return true;
    }
    console.log(`[template] applying template: ${templateId}`);
    try {
      const res = await apiFetch(`/templates/${encodeURIComponent(templateId)}`, { method: "GET" });
      if (!res.ok) { console.error(`[template] fetch failed: ${res.status}`); return false; }
      const body = await res.json();
      const template = normalizeTemplate(body.template || body);
      if (!template) { console.error("[template] not found"); return false; }
      if (template.soulMd || template.soul_md) {
        const soulMd = template.soulMd || template.soul_md;
        fs.mkdirSync(workspaceDir, { recursive: true });
        fs.writeFileSync(soulPath, soulMd, "utf8");
        console.log(`[template] wrote SOUL.md (${soulMd.length} chars)`);
      }
      applyMemoryFiles(template.memoryFiles || template.memory_files);
      return true;
    } catch (err) {
      console.error(`[template] apply error: ${err.message}`);
      return false;
    }
  }

  async function markReminderExecuted(reminderId) {
    try {
      await apiFetch("/agent/reminders/executed", {
        method: "POST",
        body: JSON.stringify({ instance_id: instanceId, reminder_id: reminderId, executed_at: new Date().toISOString() }),
      });
    } catch (err) {
      console.error(`[reminders] mark executed error: ${err.message}`);
    }
  }

  async function executeReminder(reminder) {
    if (!isGatewayReady()) { console.warn(`[reminders] gateway not ready, skipping: ${reminder.title}`); return; }
    try {
      const res = await fetch(`${gatewayTarget}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayToken}` },
        body: JSON.stringify({ method: "cron.wake", params: { text: reminder.message, source: "oneclaw-reminder", reminderId: reminder.id } }),
      });
      if (res.ok) { console.log(`[reminders] executed: ${reminder.title}`); await markReminderExecuted(reminder.id); }
    } catch (err) {
      console.error(`[reminders] execute error: ${err.message}`);
    }
  }

  async function checkReminders() {
    try {
      const res = await apiFetch(`/agent/reminders/due?instance_id=${encodeURIComponent(instanceId)}`, { method: "GET" });
      if (res.ok) {
        const { reminders = [] } = await res.json();
        for (const r of reminders) { console.log(`[reminders] executing: ${r.title}`); await executeReminder(r); }
      }
    } catch (err) {
      if (err.message !== "fetch failed") console.error(`[reminders] check error: ${err.message}`);
    }
  }

  async function sendHeartbeat() {
    try {
      const status = isGatewayReady() ? "healthy" : isGatewayStarting() ? "starting" : "unhealthy";
      // Report platform/channel state so the OneClaw dashboard's
      // "Connected Platforms" section flips from "waiting" → "connected"
      // once a channel is reachable. We treat a channel as online when its
      // env credentials are present AND the gateway is ready (i.e. the
      // plugin has booted). This matches what the inbound message logs show.
      const gatewayReady = isGatewayReady();
      const statusReason = gatewayReady ? "gateway_ready" : isGatewayStarting() ? "gateway_starting" : "gateway_unhealthy";
      const platforms = gatewayReady ? {
        telegram: !!process.env.TELEGRAM_BOT_TOKEN?.trim(),
        discord: !!process.env.DISCORD_BOT_TOKEN?.trim(),
        feishu: !!(process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim()),
        whatsapp: process.env.WHATSAPP_ENABLED === "1",
        wechat: process.env.WECHAT_ENABLED === "1",
      } : {};
      const res = await apiFetch("/agent/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          instance_id: instanceId,
          status,
          status_reason: statusReason,
          agent: {
            timestamp: new Date().toISOString(),
            uptime_seconds: process.uptime(),
            gateway_ready: gatewayReady,
            platforms,
          },
        }),
      });
      if (res.ok) {
        console.log(`[heartbeat] sent: ${status}`);
        try {
          const result = await res.json();
          if (Array.isArray(result.commands) && result.commands.length > 0) {
            for (const cmd of result.commands) {
              await applyAgentCommand(cmd);
            }
          }
        } catch {}
        if (usageStats.messages > 0) await reportStats();
      } else {
        console.warn(`[heartbeat] failed: ${res.status}`);
      }
    } catch (err) {
      console.error(`[heartbeat] error: ${err.message}`);
    }
  }

  function start(openclawVersion) {
    setTimeout(async () => {
      sendHeartbeat();
      sendEvent("instance_started", { version: openclawVersion });
      const { personality, template } = await fetchPersonality();
      if (personality || template) await applyPersonality(personality, template);
    }, 30_000);
    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    remindersInterval = setInterval(checkReminders, REMINDERS_CHECK_INTERVAL_MS);
    console.log(`[heartbeat] started (interval: ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
    console.log(`[reminders] check started (interval: ${REMINDERS_CHECK_INTERVAL_MS / 1000}s)`);
  }

  function stop() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (remindersInterval) { clearInterval(remindersInterval); remindersInterval = null; }
  }

  function applyMemoryFiles(memoryFiles) {
    if (!Array.isArray(memoryFiles)) return;
    for (const file of memoryFiles) {
      if (file.path && file.content) {
        const filePath = path.join(workspaceDir, file.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content, "utf8");
        console.log(`[template] applied ${file.path}`);
      }
    }
  }

  async function applyAgentCommand(command) {
    const payload = command?.payload || command || {};
    if (command?.type !== "apply_template") return;
    const soulMd = payload.soul_md || payload.soulMd;
    if (soulMd) {
      const soulPath = path.join(workspaceDir, "SOUL.md");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(soulPath, soulMd, "utf8");
      console.log(`[command] wrote SOUL.md (${soulMd.length} chars)`);
    }
    // Go 后端 command 使用 payload.memory_files；保留 memoryFiles 读取，方便旧队列平滑过渡。
    applyMemoryFiles(payload.memory_files || payload.memoryFiles);
  }

  return { start, stop, sendHeartbeat, sendEvent, trackMessage, fetchPersonality, applyPersonality, applyTemplateFromEnv, getCachedPersonality: () => cachedPersonality };
}

function normalizePersonality(personality) {
  if (!personality) return null;
  return {
    ...personality,
    botName: personality.botName || personality.bot_name,
    systemPrompt: personality.systemPrompt || personality.system_prompt,
  };
}

function normalizeTemplate(template) {
  if (!template) return null;
  return {
    ...template,
    templateId: template.templateId || template.template_id || template.id,
    soulMd: template.soulMd || template.soul_md,
    memoryFiles: template.memoryFiles || template.memory_files,
    suggestedModel: template.suggestedModel || template.suggested_model,
  };
}
