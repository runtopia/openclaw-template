// OneClaw platform integration.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRuntimeChannelAccessPolicy, mergeChannelPolicy } from "../channels/access-policy.js";
import { CHANNEL_MANIFEST, setChannelAccountConfig, setChannelConfig } from "../channels/manifest.js";
import { approvePairingRequest, listPairingRequests, normalizePairingChannel, resolveOpenClawEntryFromClawArgs } from "../channels/pairing-store.js";
import { agentWorkspace, safeAgentFilePath } from "../agents/workspace.js";

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 小时
const COMMAND_POLL_INTERVAL_MS = Number(process.env.ONECLAW_COMMAND_POLL_INTERVAL_MS ?? 5_000);

export function normalizeOneclawApiUrl(raw) {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (base.endsWith("/api/v1")) return base;
  if (base.endsWith("/api")) return `${base}/v1`;
  return `${base}/api/v1`;
}

export function createOneclawIntegration({
	apiUrl, instanceId, instanceSecret, stateDir, workspaceDir,
	gatewayTarget, repairTarget, gatewayToken, isGatewayReady, isGatewayStarting,
	gatewayRpc,
	runCmd, clawArgs, OPENCLAW_NODE, restartGateway, getGatewayLogs,
	channelBindingPollMs = 1500,
}) {
  const platformApiUrl = normalizeOneclawApiUrl(apiUrl);
  const mainWorkspace = agentWorkspace(workspaceDir, "main");
  if (!platformApiUrl || !instanceId || !instanceSecret) {
    return {
      start() {},
      stop() {},
      sendHeartbeat() {},
      pollCommands() {},
      sendEvent() {},
      trackMessage() {},
      getCachedPersonality() { return null; },
      fetchPersonality() { return Promise.resolve({ personality: null, template: null }); },
      applyPersonality() { return Promise.resolve(); },
      applyTemplateFromEnv() { return Promise.resolve(false); },
    };
  }

  let heartbeatInterval = null;
	let commandPollInterval = null;
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

  async function reportChannelAccessRequest(payload) {
    try {
      const res = await apiFetch("/agent/channels/access-requests", {
        method: "POST",
        body: JSON.stringify({ instance_id: instanceId, ...payload }),
      });
      if (!res.ok) console.warn(`[channel-access] request report failed: ${res.status}`);
    } catch (err) {
      console.error(`[channel-access] request report error: ${err.message}`);
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
        const soulPath = path.join(mainWorkspace, "SOUL.md");
        fs.mkdirSync(mainWorkspace, { recursive: true });
        fs.writeFileSync(soulPath, systemPrompt, "utf8");
        console.log(`[personality] applied system prompt`);
      }
      applyMemoryFiles(template?.memoryFiles || template?.memory_files, mainWorkspace);
    } catch (err) {
      console.error(`[personality] apply error: ${err.message}`);
    }
  }

  async function applyTemplateFromEnv(templateId) {
    if (!templateId) return false;
    const soulPath = path.join(mainWorkspace, "SOUL.md");
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
        fs.mkdirSync(mainWorkspace, { recursive: true });
        fs.writeFileSync(soulPath, soulMd, "utf8");
        console.log(`[template] wrote SOUL.md (${soulMd.length} chars)`);
      }
      applyMemoryFiles(template.memoryFiles || template.memory_files, mainWorkspace);
      return true;
    } catch (err) {
      console.error(`[template] apply error: ${err.message}`);
      return false;
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
          await applyAgentCommands(result.commands);
        } catch {}
        if (usageStats.messages > 0) await reportStats();
      } else {
        console.warn(`[heartbeat] failed: ${res.status}`);
      }
    } catch (err) {
      console.error(`[heartbeat] error: ${err.message}`);
    }
  }

  async function pollCommands() {
    try {
      const res = await apiFetch(`/agent/commands?instance_id=${encodeURIComponent(instanceId)}&limit=10`, { method: "GET" });
      if (!res.ok) {
        if (res.status !== 404) console.warn(`[commands] poll failed: ${res.status}`);
        return;
      }
      const result = await res.json().catch(() => ({}));
      await applyAgentCommands(result.commands);
    } catch (err) {
      console.error(`[commands] poll error: ${err.message}`);
    }
  }

  async function applyAgentCommands(commands) {
    if (!Array.isArray(commands) || commands.length === 0) return;
    for (const cmd of commands) {
      try {
        await applyAgentCommand(cmd);
        if (cmd?.status === "leased") await acknowledgeCommand(cmd, { status: "succeeded", retryable: false });
      } catch (err) {
        const retryable = /gateway|disconnected|timeout|unavailable|ECONN/i.test(String(err?.message || err));
        if (cmd?.status === "leased") await acknowledgeCommand(cmd, { status: "failed", retryable, error: String(err?.message || err) });
      }
    }
  }

  async function acknowledgeCommand(command, result) {
    const res = await apiFetch(`/agent/commands/${encodeURIComponent(command.id)}/ack?instance_id=${encodeURIComponent(instanceId)}`, {
      method: "POST",
      body: JSON.stringify(result),
    });
    if (!res.ok) throw new Error(`command acknowledgement failed: ${res.status}`);
  }

  function start(openclawVersion) {
    setTimeout(async () => {
      sendHeartbeat();
      sendEvent("instance_started", { version: openclawVersion });
      const { personality, template } = await fetchPersonality();
      if (personality || template) await applyPersonality(personality, template);
    }, 30_000);
    heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    // 员工雇佣、通道绑定、技能安装需要秒级生效；heartbeat 保持低频，命令用轻量轮询承接。
    commandPollInterval = setInterval(pollCommands, COMMAND_POLL_INTERVAL_MS);
    setTimeout(pollCommands, Math.min(COMMAND_POLL_INTERVAL_MS, 5_000));
    console.log(`[heartbeat] started (interval: ${HEARTBEAT_INTERVAL_MS / 1000}s)`);
    console.log(`[commands] poll started (interval: ${COMMAND_POLL_INTERVAL_MS / 1000}s)`);
  }

  function stop() {
    if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
    if (commandPollInterval) { clearInterval(commandPollInterval); commandPollInterval = null; }
    for (const session of activeChannelBindings.values()) cancelChannelBindingSession(session);
    activeChannelBindings.clear();
  }

  function applyMemoryFiles(memoryFiles, targetWorkspace = mainWorkspace) {
    if (!Array.isArray(memoryFiles)) return;
    for (const file of memoryFiles) {
      if (file.path && file.content) {
        const filePath = safeAgentFilePath(targetWorkspace, file.path);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, file.content, "utf8");
        console.log(`[template] applied ${file.path}`);
      }
    }
  }

  async function applyAgentCommand(command) {
    const payload = command?.payload || command || {};
    if (command?.type === "restart") {
      await restartRuntimeGateway(command);
      return;
    }
    if (command?.type === "get_logs") {
      await reportRuntimeLogs(command);
      return;
    }
    if (command?.type === "update_config") {
      await applyUpdateConfigCommand(payload);
      return;
    }
    if (command?.type === "delete_agent") {
      await deleteEmployeeAgent(payload);
      return;
    }
    if (command?.type === "install_skill") {
      await installEmployeeSkill(payload);
      return;
    }
    if (command?.type === "remove_skill") {
      await removeEmployeeSkill(payload);
      return;
    }
    if (command?.type === "upsert_cron_task") {
      await upsertCronTask(payload);
      return;
    }
    if (command?.type === "delete_cron_task") {
      await deleteCronTask(payload);
      return;
    }
    if (command?.type === "run_cron_task") {
      await runCronTask(payload);
      return;
    }
    if (command?.type !== "apply_template") return;
    const employeeId = String(payload.employee_id || payload.employeeId || "").trim();
    if (employeeId) {
      return applyEmployeeAgentTemplate(payload, employeeId);
    }
    const soulMd = payload.soul_md || payload.soulMd;
    if (soulMd) {
      const soulPath = path.join(mainWorkspace, "SOUL.md");
      fs.mkdirSync(mainWorkspace, { recursive: true });
      fs.writeFileSync(soulPath, soulMd, "utf8");
      console.log(`[command] wrote SOUL.md (${soulMd.length} chars)`);
    }
    // Go 后端 command 使用 payload.memory_files；保留 memoryFiles 读取，方便旧队列平滑过渡。
    applyMemoryFiles(payload.memory_files || payload.memoryFiles, mainWorkspace);
  }

  function renderManagedResponsibilities(soulMd, responsibilities) {
    const start = "<!-- ONECLAW:RESPONSIBILITIES:START -->";
    const end = "<!-- ONECLAW:RESPONSIBILITIES:END -->";
    const managedPattern = /\n?<!-- ONECLAW:RESPONSIBILITIES:START -->[\s\S]*?<!-- ONECLAW:RESPONSIBILITIES:END -->\n?/g;
    const base = String(soulMd || "").replace(managedPattern, "\n").trim();
    const items = responsibilities
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .map((item) => `- ${item}`);
    if (items.length === 0) return base;
    const section = `${start}\n## Core Responsibilities\n${items.join("\n")}\n${end}`;
    return base ? `${base}\n\n${section}\n` : `${section}\n`;
  }

  function normalizeTemplateSkillRequirements(payload) {
    if (Array.isArray(payload.skill_requirements)) return payload.skill_requirements;
    if (Array.isArray(payload.skillRequirements)) return payload.skillRequirements;
    if (Array.isArray(payload.skill_specs)) return payload.skill_specs;
    if (Array.isArray(payload.skills)) return payload.skills.map((slug) => ({ slug, required: false, install_policy: "recommend" }));
    return [];
  }

  function boundedComponentError(err) {
    return String(err?.message || err || "component failed").slice(0, 500);
  }

  async function applyEmployeeAgentTemplate(payload, employeeId) {
    if (!gatewayRpc?.rpcGateway) {
      console.warn("[command] gateway rpc unavailable; cannot sync employee agent");
      return;
    }
    await gatewayRpc.waitUntilConnected?.(10_000);
    const agentId = await ensureEmployeeAgent(payload, employeeId);
    const result = {
      employee_id: employeeId,
      template_version: Number(payload.template_version || payload.templateVersion || 1),
      overall_status: "active",
      components: {
        soul: { status: "skipped" },
        responsibilities: { status: "skipped" },
        memory: { status: "skipped" },
        skills: [],
      },
    };

    const soulMd = String(payload.soul_md || payload.soulMd || "");
    const responsibilities = Array.isArray(payload.responsibilities) ? payload.responsibilities : [];
    if (soulMd || responsibilities.length > 0) {
      try {
        const content = renderManagedResponsibilities(soulMd, responsibilities);
        await callGateway("agents.files.set", { agentId, name: "SOUL.md", content });
        if (soulMd) result.components.soul = { status: "active" };
        if (responsibilities.length > 0) result.components.responsibilities = { status: "active" };
      } catch (err) {
        const error = boundedComponentError(err);
        if (soulMd) result.components.soul = { status: "failed", error };
        if (responsibilities.length > 0) result.components.responsibilities = { status: "failed", error };
      }
    }

    const memoryFiles = payload.memory_files || payload.memoryFiles || [];
    if (Array.isArray(memoryFiles) && memoryFiles.length > 0) {
      const failures = [];
      for (const file of memoryFiles) {
        if (!file?.path || typeof file.content !== "string") continue;
        try {
          if (file.path === "MEMORY.md") {
            await callGateway("agents.files.set", { agentId, name: "MEMORY.md", content: file.content });
            continue;
          }
          const filePath = safeAgentFilePath(agentWorkspace(workspaceDir, agentId), file.path);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, file.content, "utf8");
        } catch (err) {
          failures.push(boundedComponentError(err));
        }
      }
      result.components.memory = failures.length > 0
        ? { status: "failed", error: failures.join("; ").slice(0, 500) }
        : { status: "active" };
    }

    const requestedSkills = normalizeTemplateSkillRequirements(payload);
    for (const requirement of requestedSkills) {
      const slug = String(requirement?.slug || requirement?.skill_slug || requirement || "").trim();
      if (!slug) continue;
      if (requirement?.install_policy === "manual") {
        result.components.skills.push({ slug, status: "manual" });
        continue;
      }
      try {
        const spec = await resolveRuntimeSkillSpec(requirement);
        await installSkillForAgent(spec, agentId, payload.credentials);
        result.components.skills.push({ slug, status: "active" });
      } catch (err) {
        const error = boundedComponentError(err);
        result.components.skills.push({ slug, status: "failed", required: requirement?.required === true, error });
        console.warn(`[command] employee skill ${slug} sync failed: ${error}`);
      }
    }

    const componentResults = [result.components.soul, result.components.responsibilities, result.components.memory, ...result.components.skills];
    if (componentResults.some((component) => component?.status === "failed" || component?.status === "needs_configuration")) {
      result.overall_status = "degraded";
    }
    console.log(`[command] synced employee agent ${employeeId} -> ${agentId} (${result.overall_status})`);
    return result;
  }

  async function ensureEmployeeAgent(payload, employeeId) {
    const preferredAgentId = String(payload.openclaw_agent_id || payload.agent_id || "").trim();
    const stableName = preferredAgentId || `oneclaw-${employeeId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    if (stableName === "main") return "main";
    const workspace = agentWorkspace(workspaceDir, stableName);
    const listed = await callGateway("agents.list", {}, { tolerateError: true });
    const agents = listed?.agents || listed?.result?.agents || listed?.payload?.agents || [];
    const existing = agents.find((agent) => agent?.id === stableName || agent?.agentId === stableName || agent?.name === stableName);
    if (existing) return existing.id || existing.agentId || stableName;
    const createFrame = await callGateway("agents.create", {
      name: stableName,
      workspace,
      model: "clawrouters/auto",
      emoji: payload.avatar || "",
      avatar: "",
    }, { tolerateError: true });
    if (createFrame?.agentId) return createFrame.agentId;
    if (createFrame?.result?.agentId) return createFrame.result.agentId;
    if (createFrame?.payload?.agentId) return createFrame.payload.agentId;
    return stableName;
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
      throw err;
    }
  }

  async function installEmployeeSkill(payload) {
    const slug = String(payload.skill_slug || payload.skillSlug || payload.slug || "").trim();
    if (!slug) return;
    const employeeId = String(payload.employee_id || payload.employeeId || "").trim();
    try {
      const agentId = employeeId ? await ensureEmployeeAgent(payload, employeeId) : String(payload.agent_id || payload.agentId || "main").trim();
      const spec = await resolveRuntimeSkillSpec({
        slug,
        source: payload.source,
        version: payload.version,
        force: payload.force,
      });
      await installSkillForAgent(spec, agentId || "main", payload.credentials);
      console.log(`[command] installed skill ${slug} for ${agentId || "main"}`);
    } catch (err) {
      console.error(`[command] install skill ${slug} failed: ${err.message}`);
      throw err;
    }
  }

  async function resolveRuntimeSkillSpec(value) {
    const inline = typeof value === "string" ? { slug: value } : (value || {});
    const slug = String(inline.slug || inline.skill_slug || "").trim();
    if (!slug) throw new Error("skill slug is required");
    const res = await apiFetch(`/agent/skills/${encodeURIComponent(slug)}?instance_id=${encodeURIComponent(instanceId)}`, { method: "GET" });
    const spec = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(spec.error || `skill ${slug} resolution failed: ${res.status}`);
    return {
      ...spec,
      slug: spec.slug || slug,
      ...(inline.version ? { version: inline.version } : {}),
      ...(inline.force === true ? { force: true } : {}),
    };
  }

  async function installSkillForAgent(spec, agentId, credentials) {
    const source = String(spec?.source || "").trim();
    const slug = String(spec?.slug || "").trim();
    if (!slug || !source) throw new Error("skill slug and source are required");
    if (source === "builtin") {
      const frame = await callGateway("skills.status", { agentId });
      const skills = frame?.skills || frame?.result?.skills || frame?.payload?.skills || [];
      if (!Array.isArray(skills) || !skills.some((skill) => skill?.name === slug || skill?.slug === slug || skill?.skillKey === slug)) {
        throw new Error(`builtin skill ${slug} is not available in this runtime`);
      }
      if (credentials && Object.keys(credentials).length > 0) {
        await callGateway("skills.update", { skillKey: slug, ...credentials });
      }
      console.log(`[command] builtin skill ${slug} available for ${agentId}`);
      return;
    }
    if (typeof runCmd !== "function" || typeof clawArgs !== "function" || !OPENCLAW_NODE) {
      throw new Error("OpenClaw CLI unavailable");
    }
    if (source === "custom") {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-skill-"));
      const zipPath = path.join(tempRoot, `${slug}.zip`);
      const extractPath = path.join(tempRoot, "contents");
      try {
        const query = new URLSearchParams({ instance_id: instanceId });
        if (spec.version) query.set("version", String(spec.version));
        const res = await apiFetch(`/agent/skills/${encodeURIComponent(slug)}/archive?${query}`, { method: "GET" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `custom skill ${slug} download failed: ${res.status}`);
        }
        fs.mkdirSync(extractPath, { recursive: true });
        fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
        const unpack = await runCmd("unzip", ["-o", zipPath, "-d", extractPath]);
        if (unpack.code !== 0) throw new Error(unpack.output || `failed to extract custom skill ${slug}`);
        const args = ["skills", "install", extractPath, "--as", slug, "--agent", agentId];
        if (spec.force === true) args.push("--force");
        const installed = await runCmd(OPENCLAW_NODE, clawArgs(args));
        if (installed.code !== 0) throw new Error(installed.output || `failed to install custom skill ${slug}`);
        return;
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
    if (source !== "clawhub") throw new Error(`unsupported skill source: ${source}`);
    const args = ["skills", "install", slug, "--agent", agentId];
    if (spec.version) args.push("--version", String(spec.version));
    if (spec.force === true) args.push("--force");
    const result = await runCmd(OPENCLAW_NODE, clawArgs(args));
    if (result.code !== 0) throw new Error(result.output || `openclaw skills install exited ${result.code}`);
  }

  async function removeEmployeeSkill(payload) {
    const slug = String(payload.skill_slug || payload.skillSlug || payload.slug || "").trim();
    if (!slug) return;
    const employeeId = String(payload.employee_id || payload.employeeId || "").trim();
    const agentId = String(payload.agent_id || payload.agentId || "").trim()
      || (employeeId ? `oneclaw-${employeeId.replace(/[^a-zA-Z0-9_-]/g, "-")}` : "main");
    try {
      const skillDir = await resolveSkillDir(agentId, slug);
      if (skillDir) fs.rmSync(skillDir, { recursive: true, force: true });
      console.log(`[command] removed skill ${slug} for ${agentId}`);
    } catch (err) {
      console.warn(`[command] remove skill ${slug} failed: ${err.message}`);
    }
  }

  async function resolveSkillDir(agentId, slug) {
    if (typeof runCmd === "function" && typeof clawArgs === "function" && OPENCLAW_NODE) {
      const result = await runCmd(OPENCLAW_NODE, clawArgs(["skills", "list", "--agent", agentId, "--json"]));
      if (result.code === 0 && result.output) {
        try {
          const data = JSON.parse(result.output);
          if (data && typeof data.baseDir === "string") return path.join(data.baseDir, slug);
          if (Array.isArray(data)) {
            const entry = data.find((skill) => skill?.slug === slug);
            if (entry?.dir) return entry.dir;
            if (entry?.baseDir) return path.join(entry.baseDir, slug);
            const base = data.find((skill) => skill?.baseDir)?.baseDir;
            if (base) return path.join(base, slug);
          }
        } catch {}
      }
    }
    return path.join(agentWorkspace(workspaceDir || "/data/workspace", agentId), "skills", slug);
  }

  async function restartRuntimeGateway(command) {
    if (typeof restartGateway !== "function") return;
    try {
      const result = await restartGateway({ waitReady: false });
      if (!result?.coalesced) gatewayRpc?.restart?.();
      await sendEvent("runtime_command_executed", { command_id: command?.id || null, type: "restart", pending: true });
    } catch (err) {
      console.error(`[command] restart failed: ${err.message}`);
      await sendEvent("runtime_command_failed", { command_id: command?.id || null, type: "restart", error: err.message });
    }
  }

  async function reportRuntimeLogs(command) {
    const payload = command?.payload || {};
    const n = Math.max(1, Math.min(Number(payload.n || payload.lines || 100) || 100, 500));
    const lines = typeof getGatewayLogs === "function" ? (getGatewayLogs(n) || []).slice(-n) : [];
    await sendEvent("runtime_logs", { command_id: command?.id || null, lines });
  }

  async function upsertCronTask(payload) {
    if (!gatewayRpc?.rpcGateway) {
      console.warn("[command] gateway rpc unavailable; cannot sync cron task");
      return;
    }
    const task = normalizeCronTaskPayload(payload?.task || payload);
    if (!task?.managedId) return;
    try {
      await gatewayRpc.waitUntilConnected?.(10_000);
      const nativeId = await resolveCronNativeId(task.managedId);
      if (nativeId) {
        const { managedId, ...patch } = task;
        await callGateway("cron.update", { id: nativeId, patch });
        console.log(`[command] updated cron task ${task.managedId} -> ${nativeId}`);
      } else {
        const { managedId, ...job } = task;
        const created = await callGateway("cron.add", job);
        const createdId = created?.id || created?.job?.id || created?.result?.id;
        if (createdId) saveCronNativeId(managedId, createdId);
        console.log(`[command] added cron task ${managedId}${createdId ? ` -> ${createdId}` : ""}`);
      }
    } catch (err) {
      console.error(`[command] cron task upsert failed: ${err.message}`);
      await sendEvent("runtime_command_failed", { type: "upsert_cron_task", task_id: task.managedId, error: err.message });
    }
  }

  async function deleteCronTask(payload) {
    if (!gatewayRpc?.rpcGateway) return;
    const taskId = String(payload?.task_id || payload?.taskId || payload?.task?.id || "").trim();
    if (!taskId) return;
    try {
      await gatewayRpc.waitUntilConnected?.(10_000);
      const nativeId = await resolveCronNativeId(taskId);
      if (!nativeId) return;
      await callGateway("cron.remove", { id: nativeId }, { tolerateError: true });
      deleteCronNativeId(taskId);
      console.log(`[command] removed cron task ${taskId} -> ${nativeId}`);
    } catch (err) {
      console.warn(`[command] cron task remove failed: ${err.message}`);
    }
  }

  async function runCronTask(payload) {
    if (!gatewayRpc?.rpcGateway) return;
    const taskId = String(payload?.task_id || payload?.taskId || payload?.task?.id || "").trim();
    if (!taskId) return;
    try {
      await gatewayRpc.waitUntilConnected?.(10_000);
      const nativeId = await resolveCronNativeId(taskId);
      if (!nativeId) return;
      await callGateway("cron.run", { id: nativeId, mode: "force" });
      console.log(`[command] ran cron task ${taskId} -> ${nativeId}`);
    } catch (err) {
      console.error(`[command] cron task run failed: ${err.message}`);
    }
  }

  async function callGateway(method, params = {}, opts = {}) {
    const frame = await gatewayRpc.rpcGateway(method, params);
    if (frame?.ok === false && !opts.tolerateError) {
      throw new Error(frame.error?.message || frame.error?.code || `${method} failed`);
    }
    return frame?.payload || frame?.result || frame;
  }

  function cronMapPath() {
    return path.join(stateDir || path.dirname(workspaceDir), "oneclaw-cron-tasks.json");
  }

  function loadCronTaskMap() {
    try {
      const file = cronMapPath();
      if (!fs.existsSync(file)) return {};
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function saveCronTaskMap(map) {
    const file = cronMapPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
  }

  function saveCronNativeId(managedId, nativeId) {
    const map = loadCronTaskMap();
    map[managedId] = nativeId;
    saveCronTaskMap(map);
  }

  function deleteCronNativeId(managedId) {
    const map = loadCronTaskMap();
    delete map[managedId];
    saveCronTaskMap(map);
  }

  async function resolveCronNativeId(managedId) {
    const map = loadCronTaskMap();
    const cached = String(map[managedId] || "").trim();
    if (cached) {
      const existing = await callGateway("cron.get", { id: cached }, { tolerateError: true });
      if ((existing?.id || existing?.job?.id) === cached) return cached;
    }
    const listed = await callGateway("cron.list", { includeDisabled: true, limit: 200, query: managedId }, { tolerateError: true });
    const jobs = listed?.jobs || [];
    const found = jobs.find((job) => job?.name === managedCronTaskName(managedId, job.name) || String(job?.name || "").startsWith(`${managedId} · `));
    if (found?.id) {
      saveCronNativeId(managedId, found.id);
      return found.id;
    }
    return "";
  }

  return { start, stop, sendHeartbeat, pollCommands, sendEvent, trackMessage, fetchPersonality, applyPersonality, applyTemplateFromEnv, getCachedPersonality: () => cachedPersonality };

  async function applyUpdateConfigCommand(payload) {
    const action = payload?.action;
    if (action === "update_channel") {
      await applyRuntimeChannelUpdate(payload);
      return;
    }
    if (action === "approve_channel_access_request" || action === "reject_channel_access_request") {
      await applyChannelAccessRequestCommand(payload, action);
      return;
    }
    if (action === "sync_channel_access_requests") {
      await syncChannelAccessRequestsCommand(payload);
      return;
    }
    if (action === "bind_channel") {
      startChannelBindingSession(payload);
      return;
    }
    if (action === "cancel_bind_channel" || action === "unbind_channel") {
      await cancelChannelBindingByPayload(payload, action);
    }
  }

  async function applyChannelAccessRequestCommand(payload, action) {
    const channel = String(payload?.channel || "").trim();
    const requestId = String(payload?.request_id || payload?.requestId || payload?.pairing_code || payload?.pairingCode || "").trim();
    if (!channel || !requestId) {
      console.warn("[channel-access] invalid access request command");
      return;
    }
    const verb = action === "reject_channel_access_request" ? "reject" : "approve";
    try {
      if (verb === "reject") {
        console.log(`[channel-access] reject ${channel} ${requestId} (runtime pairing reject unsupported)`);
        return;
      }
      const approved = await approvePairingRequest({
        channel,
        code: requestId,
        accountId: payload?.account_id || payload?.accountId || "",
        openclawEntry: resolveOpenClawEntryFromClawArgs(clawArgs),
      });
      if (!approved) throw new Error(`pairing request not found: ${requestId}`);
      console.log(`[channel-access] ${verb} ${channel} ${requestId}`);
    } catch (err) {
      console.error(`[channel-access] ${verb} failed: ${err.message}`);
      await sendEvent("runtime_command_failed", {
        type: action,
        channel,
        request_id: requestId,
        error: err.message,
      });
    }
  }

  async function syncChannelAccessRequestsCommand(payload) {
    const channel = String(payload?.channel || "").trim();
    const employeeId = String(payload?.employee_id || payload?.employeeId || "").trim();
    if (!channel || !employeeId) return;
    try {
      const requests = await listPairingRequests({
        channel,
        accountId: payload?.account_id || payload?.accountId || "",
        openclawEntry: resolveOpenClawEntryFromClawArgs(clawArgs),
      });
      for (const request of requests) {
        if (!request.code) continue;
        await reportChannelAccessRequest({
          employee_id: employeeId,
          channel: normalizePairingChannel(channel),
          request_id: request.code,
          subject_type: "pairing_code",
          subject_id: request.code,
          subject_name: request.subject_name || request.subject_id || request.code,
          requested_at: request.requested_at || undefined,
        });
      }
      console.log(`[channel-access] synced ${requests.length} ${channel} pairing request(s)`);
    } catch (err) {
      console.error(`[channel-access] sync failed: ${err.message}`);
      await sendEvent("runtime_command_failed", {
        type: "sync_channel_access_requests",
        channel,
        employee_id: employeeId,
        error: err.message,
      });
    }
  }

  async function applyRuntimeChannelUpdate(payload) {
    const channel = String(payload?.channel || "").trim();
    if (!channel) return;
    const runtimeChannel = channel === "wechat" ? "openclaw-weixin" : channel;
    const state = payload?.state || {};
    const config = state.config && typeof state.config === "object" ? state.config : {};
    const secrets = state.secrets && typeof state.secrets === "object" ? state.secrets : {};
    const access = config.access ? buildRuntimeChannelAccessPolicy(config.access) : {};
    const incoming = mergeChannelPolicy({
      enabled: state.enabled !== false,
      ...config,
      ...secrets,
    }, access);
    delete incoming.access;
    const employeeId = String(payload?.employee_id || payload?.employeeId || "").trim();
    const agentId = runtimeAgentId(payload, employeeId);
    const accountId = String(payload?.account_id || payload?.accountId || agentId).trim();
    setChannelAccountConfig(runtimeChannel, accountId, agentId, incoming, { stateDir: stateDir || path.dirname(workspaceDir) });
    if (typeof restartGateway === "function") {
      const result = await restartGateway({ waitReady: false });
      if (!result?.coalesced) gatewayRpc?.restart?.();
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

  async function cancelChannelBindingByPayload(payload, action = "cancel_bind_channel") {
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
    if (action === "unbind_channel") {
      await unbindRuntimeChannel(payload, channel, employeeId);
      await restartRuntimeAfterChannelChange();
    }
    await reportChannelState({
      employee_id: employeeId,
      channel,
      status: action === "unbind_channel" ? "unbound" : "expired",
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
    ensureQrChannelRuntimeConfig(channel, payload);

    const key = bindingKey(channel, employeeId);
    const previous = activeChannelBindings.get(key);
    if (previous) cancelChannelBindingSession(previous);

    // 本次扫码绑定是用户发起的一次性会话；expires_at 是总截止时间，
    // 到期后必须停止刷新二维码，避免用户离开页面后实例继续刷日志。
    const session = {
      key,
      channel,
      employeeId,
      agentId: runtimeAgentId(payload, employeeId),
      sessionId,
      expiresAt,
      expiresAtRaw,
      started: false,
      currentQrUrl: null,
      cancelled: false,
      timer: null,
    };
    activeChannelBindings.set(key, session);
    runChannelBindingTick(session);
  }

  function ensureQrChannelRuntimeConfig(channel, payload) {
    const runtimeChannel = channel === "wechat" ? "openclaw-weixin" : channel;
    const manifestEntry = CHANNEL_MANIFEST.find((entry) => entry.id === runtimeChannel);
    if (!manifestEntry?.reconcileShape) return;
    const configState = payload?.state?.config || payload?.config || {};
    const access = configState?.access;
    const runtimePolicy = access ? buildRuntimeChannelAccessPolicy(access) : {};
    const shape = {
      ...manifestEntry.reconcileShape(process.env),
      ...runtimePolicy,
    };
    // 正常部署由 Go 后端通过 WECHAT_ENABLED/WHATSAPP_ENABLED 启用；这里作为老容器或异常配置的兜底。
    // 若绑定时 channel/plugin 缺失，OpenClaw CLI 会停在交互式“Install plugin?”提示，导致拿不到二维码。
    setChannelConfig(runtimeChannel, shape, {
      stateDir: stateDir || path.dirname(workspaceDir),
    });
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
      if (data?.status === "error" || data?.status === "failed" || data?.error) {
        throw new Error(data.error || data.message || `${session.channel} login failed`);
      }
      const connected = !!data.connected || data.status === "connected";
      if (connected) {
        activeChannelBindings.delete(session.key);
        session.runtimeAccountId = String(data.connectedAccountId || data.accountId || "").trim();
        await bindRuntimeChannel(session);
        // WeChat plugin login persists the account and bumps channelConfigUpdatedAt,
        // which makes OpenClaw reload itself. Forcing a second wrapper restart here
        // races that in-process reload and can interrupt the freshly connected gateway.
        if (session.channel !== "wechat") await restartRuntimeAfterChannelChange();
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
          qr_expires_at: channelQrExpiresAt(data),
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

  function channelQrExpiresAt(data) {
    const raw = data?.qr_expires_at ?? data?.qrExpiresAt ?? data?.expires_at ?? data?.expiresAt ?? null;
    if (typeof raw !== "string" || raw.trim() === "") return undefined;
    return raw.trim();
  }

  async function pollWhatsAppBinding(session) {
    if (!session.started) {
      session.started = true;
      return repairFetch("whatsapp-login/start", "POST", {
        accountId: session.employeeId,
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
      return repairFetch("wechat-login/start", "POST", {
        accountId: session.employeeId,
        expiresAt: session.expiresAtRaw,
      });
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

  async function bindRuntimeChannel(session) {
    const runtimeChannel = runtimeChannelName(session.channel);
    const accountId = runtimeChannelAccountId(session.channel, session.employeeId, session.runtimeAccountId);
    if (!runtimeChannel || !accountId || !session.agentId) return;
    try {
      await repairFetch("bind-channel", "POST", {
        channel: runtimeChannel,
        accountId,
        agentId: session.agentId,
      });
    } catch (err) {
      console.warn(`[channel-bind] failed to bind runtime channel ${runtimeChannel}: ${err.message}`);
    }
  }

  async function unbindRuntimeChannel(payload, channel, employeeId) {
    const runtimeChannel = runtimeChannelName(channel);
    const agentId = runtimeAgentId(payload, employeeId);
    const accountId = runtimeAccountIdFromPayload(payload, channel, employeeId);
    if (!runtimeChannel || !accountId || !agentId) return;
    try {
      await repairFetch("unbind-channel", "POST", {
        channel: runtimeChannel,
        accountId,
        agentId,
      });
    } catch (err) {
      console.warn(`[channel-bind] failed to unbind runtime channel ${runtimeChannel}: ${err.message}`);
      throw err;
    }
  }

  async function restartRuntimeAfterChannelChange() {
    try {
      if (typeof restartGateway === "function") {
        const result = await restartGateway({ waitReady: false });
        if (!result?.coalesced) gatewayRpc?.restart?.();
        return;
      }
      await repairFetch("restart", "POST");
    } catch (err) {
      console.warn(`[channel-bind] failed to restart gateway after channel change: ${err.message}`);
    }
  }

  function runtimeChannelName(channel) {
    return channel === "wechat" ? "openclaw-weixin" : channel;
  }

  function runtimeChannelAccountId(channel, employeeId, runtimeAccountId) {
    const accountId = String(runtimeAccountId || "").trim();
    return accountId || employeeId;
  }

  function runtimeAccountIdFromPayload(payload, channel, employeeId) {
    const stateConfig = payload?.state?.config || payload?.config || {};
    const runtimeAccountId = String(
      payload?.runtime_account_id ||
      payload?.runtimeAccountId ||
      payload?.account_id ||
      payload?.accountId ||
      stateConfig.account_id ||
      stateConfig.accountId ||
      "",
    ).trim();
    return runtimeChannelAccountId(channel, employeeId, runtimeAccountId);
  }

  function runtimeAgentId(payload, employeeId) {
    return String(payload?.openclaw_agent_id || payload?.agent_id || payload?.agentId || "").trim()
      || (employeeId ? `oneclaw-${employeeId.replace(/[^a-zA-Z0-9_-]/g, "-")}` : "");
  }
}

function normalizeCronTaskPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.task_id || raw.taskId || "").trim();
  if (!id) return null;
  return {
    managedId: id,
    name: managedCronTaskName(id, raw.name || id),
    description: String(raw.description || "Managed by OneClaw").trim(),
    schedule: normalizeCronSchedule(raw.schedule),
    sessionTarget: raw.sessionTarget || raw.session_target || "isolated",
    wakeMode: raw.wakeMode || raw.wake_mode || "now",
    payload: normalizeCronPayload(raw.payload),
    delivery: normalizeCronDelivery(raw.delivery),
    agentId: raw.agentId || raw.agent_id || "main",
    enabled: raw.enabled !== false,
  };
}

function managedCronTaskName(managedId, name) {
  const cleanName = String(name || managedId).replace(new RegExp(`^${escapeRegExp(managedId)}\\s+·\\s+`), "").trim();
  return `${managedId} · ${cleanName || managedId}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeCronSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return { kind: "cron", expr: "0 9 * * *" };
  if (schedule.kind === "every") {
    return {
      kind: "every",
      everyMs: Number(schedule.everyMs || schedule.every_ms || 60_000),
      ...(schedule.anchorMs || schedule.anchor_ms ? { anchorMs: Number(schedule.anchorMs || schedule.anchor_ms) } : {}),
    };
  }
  return {
    kind: "cron",
    expr: String(schedule.expr || "0 9 * * *"),
    ...(schedule.tz ? { tz: String(schedule.tz) } : {}),
    ...(schedule.staggerMs || schedule.stagger_ms ? { staggerMs: Number(schedule.staggerMs || schedule.stagger_ms) } : {}),
  };
}

function normalizeCronPayload(payload) {
  if (!payload || typeof payload !== "object") return { kind: "agentTurn", message: "" };
  if (payload.kind === "systemEvent") return { kind: "systemEvent", text: String(payload.text || "") };
  if (payload.kind === "command") return { ...payload };
  return {
    kind: "agentTurn",
    message: String(payload.message || ""),
    ...(payload.model ? { model: String(payload.model) } : {}),
    ...(payload.thinking ? { thinking: String(payload.thinking) } : {}),
    ...(payload.timeoutSeconds || payload.timeout_seconds ? { timeoutSeconds: Number(payload.timeoutSeconds || payload.timeout_seconds) } : {}),
    ...(payload.lightContext !== undefined || payload.light_context !== undefined ? { lightContext: payload.lightContext ?? payload.light_context } : {}),
  };
}

function normalizeCronDelivery(delivery) {
  if (!delivery || typeof delivery !== "object") return { mode: "none" };
  const mode = String(delivery.mode || "none").trim();
  if (mode === "none") return { mode };
  return {
    mode,
    ...(delivery.channel ? { channel: String(delivery.channel) } : {}),
    ...(delivery.to ? { to: String(delivery.to) } : {}),
    ...(delivery.threadId || delivery.thread_id ? { threadId: String(delivery.threadId || delivery.thread_id) } : {}),
    ...(delivery.accountId || delivery.account_id ? { accountId: String(delivery.accountId || delivery.account_id) } : {}),
    ...(delivery.bestEffort !== undefined || delivery.best_effort !== undefined ? { bestEffort: delivery.bestEffort ?? delivery.best_effort } : {}),
  };
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
