// OneClaw platform integration.

import fs from "node:fs";
import path from "node:path";

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 小时
const REMINDERS_CHECK_INTERVAL_MS = 60 * 1000;

export function createOneclawIntegration({
  apiUrl, instanceId, instanceSecret, workspaceDir,
  gatewayTarget, gatewayToken, isGatewayReady, isGatewayStarting,
}) {
  if (!apiUrl || !instanceId || !instanceSecret) {
    return {
      start() {},
      stop() {},
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
    return fetch(`${apiUrl}${endpoint}`, {
      ...opts,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${instanceSecret}`, ...(opts.headers || {}) },
    });
  }

  async function sendEvent(event, data = {}) {
    try {
      await apiFetch("/agent/event", {
        method: "POST",
        body: JSON.stringify({ instanceId, event, data, timestamp: new Date().toISOString() }),
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
        body: JSON.stringify({ instanceId, secret: instanceSecret, messages: usageStats.messages, tokens: usageStats.tokens, model: usageStats.lastModel }),
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
      const res = await apiFetch(`/agent/personality?instanceId=${instanceId}`, { method: "GET" });
      if (res.ok) {
        const data = await res.json();
        cachedPersonality = data.personality;
        console.log(`[personality] fetched: ${cachedPersonality?.botName || "default"}`);
        return { personality: data.personality, template: data.template };
      }
    } catch (err) {
      console.error(`[personality] fetch error: ${err.message}`);
    }
    return { personality: null, template: null };
  }

  async function applyPersonality(personality, template = null) {
    try {
      if (personality?.systemPrompt) {
        const soulPath = path.join(workspaceDir, "SOUL.md");
        fs.writeFileSync(soulPath, personality.systemPrompt, "utf8");
        console.log(`[personality] applied system prompt`);
      }
      if (template?.memoryFiles && Array.isArray(template.memoryFiles)) {
        for (const file of template.memoryFiles) {
          if (file.path && file.content) {
            const filePath = path.join(workspaceDir, file.path);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, file.content, "utf8");
            console.log(`[template] applied ${file.path}`);
          }
        }
      }
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
      const res = await fetch(`${apiUrl}/templates?id=${templateId}`);
      if (!res.ok) { console.error(`[template] fetch failed: ${res.status}`); return false; }
      const { template } = await res.json();
      if (!template) { console.error("[template] not found"); return false; }
      if (template.soulMd) {
        fs.mkdirSync(workspaceDir, { recursive: true });
        fs.writeFileSync(soulPath, template.soulMd, "utf8");
        console.log(`[template] wrote SOUL.md (${template.soulMd.length} chars)`);
      }
      if (Array.isArray(template.memoryFiles)) {
        for (const file of template.memoryFiles) {
          if (file.path && file.content) {
            const filePath = path.join(workspaceDir, file.path);
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, file.content, "utf8");
            console.log(`[template] wrote ${file.path}`);
          }
        }
      }
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
        body: JSON.stringify({ instanceId, reminderId, executedAt: new Date().toISOString() }),
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
      const res = await apiFetch(`/agent/reminders/due?instanceId=${instanceId}`, { method: "GET" });
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
      const platforms = gatewayReady ? {
        telegram: !!process.env.TELEGRAM_BOT_TOKEN?.trim(),
        discord: !!process.env.DISCORD_BOT_TOKEN?.trim(),
        feishu: !!(process.env.FEISHU_APP_ID?.trim() && process.env.FEISHU_APP_SECRET?.trim()),
        whatsapp: process.env.WHATSAPP_ENABLED === "1",
        wechat: process.env.WECHAT_ENABLED === "1",
      } : {};
      const res = await apiFetch("/agent/heartbeat", {
        method: "POST",
        body: JSON.stringify({ instanceId, status, timestamp: new Date().toISOString(), uptime: process.uptime(), gatewayReady, platforms }),
      });
      if (res.ok) {
        console.log(`[heartbeat] sent: ${status}`);
        try {
          const result = await res.json();
          if (Array.isArray(result.commands) && result.commands.length > 0) {
            for (const cmd of result.commands) {
              if (cmd.type === "apply_template" && cmd.soulMd) {
                const soulPath = path.join(workspaceDir, "SOUL.md");
                fs.mkdirSync(workspaceDir, { recursive: true });
                fs.writeFileSync(soulPath, cmd.soulMd, "utf8");
                console.log(`[command] wrote SOUL.md (${cmd.soulMd.length} chars)`);
              }
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

  return { start, stop, sendEvent, trackMessage, fetchPersonality, applyPersonality, applyTemplateFromEnv, getCachedPersonality: () => cachedPersonality };
}