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
	gatewayTarget, repairTarget, gatewayToken, isGatewayReady, isGatewayStarting,
	gatewayRpc,
	channelBindingPollMs = 1500,
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
	const activeChannelBindings = new Map();

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

  async function repairFetch(pathname, method = "GET", body = undefined) {
    const target = repairTarget || gatewayTarget;
    if (!target) throw new Error("repair target unavailable");
    const headers = { "Content-Type": "application/json" };
    if (instanceSecret) headers.Authorization = `Bearer ${instanceSecret}`;
    const res = await fetch(`${target}/repair/${pathname.replace(/^\/+/, "")}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || data.message || `repair ${pathname} failed: ${res.status}`);
    return data;
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

  async function reportChannelState(payload) {
    try {
      const res = await apiFetch("/agent/channels/state", {
        method: "POST",
        body: JSON.stringify({ instance_id: instanceId, ...payload }),
      });
      if (!res.ok) console.warn(`[channel-bind] state report failed: ${res.status}`);
    } catch (err) {
      console.error(`[channel-bind] state report error: ${err.message}`);
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
    for (const session of activeChannelBindings.values()) cancelChannelBindingSession(session);
    activeChannelBindings.clear();
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
    if (command?.type === "update_config") {
      await applyUpdateConfigCommand(payload);
      return;
    }
    if (command?.type === "delete_agent") {
      await deleteEmployeeAgent(payload);
      return;
    }
    if (command?.type !== "apply_template") return;
    const employeeId = String(payload.employee_id || payload.employeeId || "").trim();
    if (employeeId) {
      await applyEmployeeAgentTemplate(payload, employeeId);
      return;
    }
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

  async function applyEmployeeAgentTemplate(payload, employeeId) {
    if (!gatewayRpc?.rpcGateway) {
      console.warn("[command] gateway rpc unavailable; cannot sync employee agent");
      return;
    }
    try {
      await gatewayRpc.waitUntilConnected?.(10_000);
      const agentId = await ensureEmployeeAgent(payload, employeeId);
      const soulMd = payload.soul_md || payload.soulMd;
      if (soulMd) {
        await callGateway("agents.files.set", { agentId, name: "SOUL.md", content: soulMd });
      }
      for (const file of payload.memory_files || payload.memoryFiles || []) {
        if (!file?.path || typeof file.content !== "string") continue;
        await callGateway("agents.files.set", { agentId, name: file.path, content: file.content });
      }
      console.log(`[command] synced employee agent ${employeeId} -> ${agentId}`);
    } catch (err) {
      console.error(`[command] employee agent sync failed: ${err.message}`);
    }
  }

  async function ensureEmployeeAgent(payload, employeeId) {
    const preferredAgentId = String(payload.openclaw_agent_id || payload.agent_id || "").trim();
    if (preferredAgentId) return preferredAgentId;
    const stableName = `oneclaw-${employeeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const workspace = path.posix.join(workspaceDir, "agents", employeeId.replace(/[^a-zA-Z0-9_-]/g, "-"));
    const createFrame = await callGateway("agents.create", {
      name: stableName,
      workspace,
      model: payload.suggested_model || payload.suggestedModel || "clawrouters/auto",
      emoji: payload.avatar || "",
      avatar: "",
    }, { tolerateError: true });
    if (createFrame?.agentId) return createFrame.agentId;
    if (createFrame?.result?.agentId) return createFrame.result.agentId;
    if (createFrame?.payload?.agentId) return createFrame.payload.agentId;
    const listFrame = await callGateway("agents.list", {}, { tolerateError: true });
    const agents = listFrame?.result?.agents || listFrame?.payload?.agents || [];
    const found = agents.find((agent) => agent?.id === stableName || agent?.agentId === stableName || agent?.name === stableName);
    return found?.id || found?.agentId || stableName;
  }

  async function deleteEmployeeAgent(payload) {
    if (!gatewayRpc?.rpcGateway) return;
    const employeeId = String(payload.employee_id || payload.employeeId || "").trim();
    const agentId = String(payload.openclaw_agent_id || payload.agent_id || "").trim()
      || (employeeId ? `oneclaw-${employeeId.replace(/[^a-zA-Z0-9_-]/g, "-")}` : "");
    if (!agentId) return;
    try {
      await gatewayRpc.waitUntilConnected?.(10_000);
      await callGateway("agents.delete", { agentId }, { tolerateError: true });
      console.log(`[command] deleted employee agent ${agentId}`);
    } catch (err) {
      console.warn(`[command] delete employee agent failed: ${err.message}`);
    }
  }

  async function callGateway(method, params = {}, opts = {}) {
    const frame = await gatewayRpc.rpcGateway(method, params);
    if (frame?.ok === false && !opts.tolerateError) {
      throw new Error(frame.error?.message || frame.error?.code || `${method} failed`);
    }
    return frame?.payload || frame?.result || frame;
  }

  return { start, stop, sendHeartbeat, sendEvent, trackMessage, fetchPersonality, applyPersonality, applyTemplateFromEnv, getCachedPersonality: () => cachedPersonality };

  async function applyUpdateConfigCommand(payload) {
    const action = payload?.action;
    if (action === "bind_channel") {
      startChannelBindingSession(payload);
      return;
    }
    if (action === "cancel_bind_channel" || action === "unbind_channel") {
      await cancelChannelBindingByPayload(payload);
    }
  }

  function bindingKey(channel, employeeId) {
    return `${channel}:${employeeId}`;
  }

  function cancelChannelBindingSession(session) {
    session.cancelled = true;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
  }

  async function cancelChannelBindingByPayload(payload) {
    const channel = String(payload?.channel || "").trim();
    const employeeId = String(payload?.employee_id || payload?.employeeId || "").trim();
    if (!channel || !employeeId) return;
    const key = bindingKey(channel, employeeId);
    const session = activeChannelBindings.get(key);
    if (session) {
      cancelChannelBindingSession(session);
      activeChannelBindings.delete(key);
    }
    await stopRuntimeQrLogin(channel);
    await reportChannelState({
      employee_id: employeeId,
      channel,
      status: "expired",
      session_id: payload?.state?.binding?.session_id || payload?.session_id || "",
    });
  }

  function startChannelBindingSession(payload) {
    const channel = String(payload?.channel || "").trim();
    const employeeId = String(payload?.employee_id || payload?.employeeId || "").trim();
    const binding = payload?.state?.binding || payload?.binding || {};
    const sessionId = String(binding.session_id || payload?.session_id || "").trim();
    const expiresAtRaw = String(binding.expires_at || payload?.expires_at || "").trim();
    const expiresAt = Date.parse(expiresAtRaw);
    if (!employeeId || !sessionId || !Number.isFinite(expiresAt)) {
      console.warn("[channel-bind] invalid bind_channel payload");
      return;
    }
    if (channel !== "whatsapp" && channel !== "wechat") return;

    const key = bindingKey(channel, employeeId);
    const previous = activeChannelBindings.get(key);
    if (previous) cancelChannelBindingSession(previous);

    // 本次扫码绑定是用户发起的一次性会话；expires_at 是总截止时间，
    // 到期后必须停止刷新二维码，避免用户离开页面后实例继续刷日志。
    const session = {
      key,
      channel,
      employeeId,
      sessionId,
      expiresAt,
      started: false,
      currentQrUrl: null,
      cancelled: false,
      timer: null,
    };
    activeChannelBindings.set(key, session);
    runChannelBindingTick(session);
  }

  async function runChannelBindingTick(session) {
    if (session.cancelled) return;
    const remaining = session.expiresAt - Date.now();
    if (remaining <= 0) {
      activeChannelBindings.delete(session.key);
      await stopRuntimeQrLogin(session.channel);
      await reportChannelState({
        employee_id: session.employeeId,
        channel: session.channel,
        status: "expired",
        session_id: session.sessionId,
      });
      return;
    }

    try {
      const data = session.channel === "whatsapp"
        ? await pollWhatsAppBinding(session)
        : await pollWechatBinding(session);
      if (session.cancelled) return;
      const connected = !!data.connected || data.status === "connected";
      if (connected) {
        activeChannelBindings.delete(session.key);
        await reportChannelState({
          employee_id: session.employeeId,
          channel: session.channel,
          status: "ready",
          session_id: session.sessionId,
          config: data.connectedAccountId ? { account_id: data.connectedAccountId } : undefined,
        });
        return;
      }
      const qrUrl = data.qrDataUrl || data.qrUrl || null;
      if (qrUrl) {
        session.currentQrUrl = qrUrl;
        await reportChannelState({
          employee_id: session.employeeId,
          channel: session.channel,
          status: "pending",
          session_id: session.sessionId,
          qr_url: qrUrl,
        });
      }
    } catch (err) {
      console.error(`[channel-bind] ${session.channel} poll error: ${err.message}`);
      await reportChannelState({
        employee_id: session.employeeId,
        channel: session.channel,
        status: "failed",
        session_id: session.sessionId,
        error: err.message,
      });
    }

    if (!session.cancelled && activeChannelBindings.get(session.key) === session) {
      const delay = Math.max(1, Math.min(channelBindingPollMs, session.expiresAt - Date.now()));
      session.timer = setTimeout(() => runChannelBindingTick(session), delay);
    }
  }

  async function pollWhatsAppBinding(session) {
    if (!session.started) {
      session.started = true;
      return repairFetch("whatsapp-login/start", "POST", {
        accountId: session.employeeId,
        force: true,
      });
    }
    return repairFetch("whatsapp-login/wait", "POST", {
      accountId: session.employeeId,
      ...(session.currentQrUrl ? { currentQrDataUrl: session.currentQrUrl } : {}),
    });
  }

  async function pollWechatBinding(session) {
    if (!session.started) {
      session.started = true;
      return repairFetch("wechat-login/start", "POST", { accountId: session.employeeId });
    }
    return repairFetch("wechat-login", "GET");
  }

  async function stopRuntimeQrLogin(channel) {
    if (channel !== "wechat") return;
    try {
      await repairFetch("wechat-login/stop", "POST");
    } catch (err) {
      console.warn(`[channel-bind] failed to stop ${channel} login: ${err.message}`);
    }
  }
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
