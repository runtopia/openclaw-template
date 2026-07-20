// OneClaw platform integration.

import fs from "node:fs";
import path from "node:path";
import { buildRuntimeChannelAccessPolicy, mergeChannelPolicy } from "../channels/access-policy.js";
import { CHANNEL_MANIFEST, setChannelAccountConfig, setChannelConfig } from "../channels/manifest.js";
import { approvePairingRequest, listPairingRequests, normalizePairingChannel, resolveOpenClawEntryFromClawArgs } from "../channels/pairing-store.js";
import { agentWorkspace, safeAgentFilePath } from "../agents/workspace.js";
import { patchConfig } from "../config/edit.js";

const HEARTBEAT_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 小时
const COMMAND_POLL_INTERVAL_MS = Number(process.env.ONECLAW_COMMAND_POLL_INTERVAL_MS ?? 5_000);

function skillUnavailableReasons(skill) {
  const reasons = [];
  if (skill?.disabled === true) reasons.push("disabled");
  if (skill?.eligible === false) reasons.push("ineligible");
  if (skill?.blockedByAllowlist === true) reasons.push("blocked by allowlist");
  if (skill?.blockedByAgentFilter === true) reasons.push("blocked by agent filter");
  if (skill?.modelVisible === false) reasons.push("not visible to the model");
  if (skill?.notInjected === true) reasons.push("not injected into the agent context");

  const missing = skill?.missing;
  if (missing && typeof missing === "object") {
    const requirements = Object.entries(missing).flatMap(([kind, values]) => {
      if (Array.isArray(values)) return values.filter(Boolean).map((value) => `${kind}: ${value}`);
      return values ? [`${kind}: ${values}`] : [];
    });
    if (requirements.length > 0) reasons.push(`missing requirements (${requirements.join(", ")})`);
  }
  return reasons;
}

function resolveExtractedSkillRoot(extractRoot) {
  const roots = [];
  let visited = 0;

  function walk(dir, depth) {
    if (depth > 6) throw new Error("custom skill archive is nested too deeply");
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    visited += entries.length;
    if (visited > 1000) throw new Error("custom skill archive contains too many files");
    if (entries.some((entry) => entry.isSymbolicLink())) {
      throw new Error("custom skill archive must not contain symbolic links");
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) roots.push(dir);
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(extractRoot, 0);
  if (roots.length !== 1) {
    throw new Error(`custom skill archive must contain exactly one SKILL.md (found ${roots.length})`);
  }
  return roots[0];
}

export function normalizeOneclawApiUrl(raw, apiVersion = process.env.ONECLAW_API_VERSION || "v1") {
  const base = String(raw || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  if (/\/api\/v[1-9]\d*$/.test(base)) return base;
  const normalizedVersion = String(apiVersion || "v1").trim().replace(/^v?/, "v");
  if (!/^v[1-9]\d*$/.test(normalizedVersion)) {
    throw new Error(`invalid OneClaw API version: ${apiVersion}`);
  }
  if (base.endsWith("/api")) return `${base}/${normalizedVersion}`;
  return `${base}/api/${normalizedVersion}`;
}

export function createOneclawIntegration({
  apiUrl,
  instanceId,
  instanceSecret,
  stateDir,
  workspaceDir,
  gatewayTarget,
  repairTarget,
  gatewayToken,
  isGatewayReady,
  isGatewayStarting,
  gatewayRpc,
  runCmd,
  clawArgs,
  OPENCLAW_NODE,
  restartGateway,
  getGatewayLogs,
  imageVersion = process.env.IMAGE_VERSION || "dev",
  openclawVersion = process.env.OPENCLAW_VERSION || "unknown",
  runtimeContract = process.env.ONECLAW_RUNTIME_CONTRACT || "2",
  channelBindingPollMs = 1500,
  skillStatusRetryMs = 250,
  skillStatusAttempts = 12,
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
      getCachedEmployees() { return []; },
      fetchPersonality() { return Promise.resolve({ personality: null, template: null }); },
      applyPersonality() { return Promise.resolve(); },
      reconcileAllEmployees() { return Promise.resolve([]); },
      applyTemplateFromEnv() { return Promise.resolve(false); },
    };
  }

  let heartbeatInterval = null;
  let commandPollInterval = null;
  let cachedPersonality = null;
  let cachedEmployees = [];
  let reportedOpenClawVersion = String(openclawVersion || "unknown");
  const usageStats = {
    messages: 0,
    tokens: 0,
    lastModel: null,
  };
  const activeChannelBindings = new Map();

  function trackMessage(tokens = 0, model = null) {
    usageStats.messages++;
    usageStats.tokens += tokens;
    if (model) usageStats.lastModel = model;
  }

  async function apiFetch(endpoint, opts = {}) {
    return fetch(`${platformApiUrl}${endpoint}`, {
      ...opts,
      headers: {
        "Content-Type": "application/json",
        "X-OneClaw-Instance-ID": instanceId,
        "X-OneClaw-Runtime-Image": String(imageVersion),
        "X-OneClaw-OpenClaw-Version": reportedOpenClawVersion,
        "X-OneClaw-Runtime-Contract": String(runtimeContract),
        Authorization: `Bearer ${instanceSecret}`,
        ...(opts.headers || {}),
      },
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
      const res = await apiFetch("/runtime/events", {
        method: "POST",
        body: JSON.stringify({ event, data, timestamp: new Date().toISOString() }),
      });
      if (res.ok) {
        console.log(`[event] sent: ${event}`);
        return true;
      }
      console.warn(`[event] failed: ${event} (${res.status})`);
    } catch (err) {
      console.error(`[event] error: ${err.message}`);
    }
    return false;
  }

  async function reportChannelState(payload) {
    await sendEvent("channel_state", payload);
  }

  async function reportChannelAccessRequest(payload) {
    await sendEvent("channel_access_request", {
      ...payload,
      request: {
        id: payload.request_id,
        subject_type: payload.subject_type,
        subject_id: payload.subject_id,
        subject_name: payload.subject_name,
        requested_at: payload.requested_at,
      },
    });
  }

  async function reportStats() {
    if (usageStats.messages === 0) return;
    const sent = await sendEvent("runtime.stats", {
      messages: usageStats.messages,
      tokens: usageStats.tokens,
      model: usageStats.lastModel,
    });
    if (!sent) return;
    console.log(`[stats] reported: ${usageStats.messages} messages`);
    usageStats.messages = 0;
    usageStats.tokens = 0;
  }

  async function fetchPersonality() {
    try {
      const res = await apiFetch("/runtime/personality", { method: "GET" });
      if (res.ok) {
        const data = await res.json();
        const defaultModel = String(data?.workspace?.default_model || "");
        const employees = (Array.isArray(data.employees) ? data.employees : [])
          .map((employee) => ({ ...employee, model: employee?.model || defaultModel }));
        cachedEmployees = employees;
        const employee = employees.find((item) => item?.kind === "main") || employees[0] || null;
        cachedPersonality = runtimeEmployeePersonality(employee);
        console.log(`[personality] fetched: ${cachedPersonality?.botName || "default"}`);
        return {
          personality: cachedPersonality,
          template: normalizeTemplate(employee),
          employees,
          contractVersion: Number(data.contract_version || 1),
        };
      }
    } catch (err) {
      console.error(`[personality] fetch error: ${err.message}`);
    }
    return { personality: null, template: null, employees: [], contractVersion: 1 };
  }

  async function reconcileAllEmployees(employees = null) {
    const desiredEmployees = Array.isArray(employees) ? employees : (await fetchPersonality()).employees;
    const results = [];
    for (const employee of desiredEmployees) {
      if (!employee?.id || employee.status === "deleted") continue;
      const payload = runtimeEmployeeTemplatePayload(employee);
      try {
        const result = await applyEmployeeAgentTemplate(payload, employee.id);
        if (result?.employee_id) await reportEmployeeTemplateSync(result);
        results.push(result);
      } catch (err) {
        const error = boundedComponentError(err);
        const result = {
          employee_id: employee.id,
          template_version: payload.template_version,
          overall_status: "failed",
          components: { reconcile: { status: "failed", error } },
        };
        await reportEmployeeTemplateSync(result);
        results.push(result);
        console.error(`[personality] employee ${employee.id} reconciliation failed: ${error}`);
      }
    }
    return results;
  }

  async function applyPersonality(personality, template = null) {
    try {
      const runtimeEmployee = personality?.runtimeEmployee;
      if (runtimeEmployee && gatewayRpc?.rpcGateway) {
        const payload = runtimeEmployeeTemplatePayload(runtimeEmployee);
        const result = await applyEmployeeAgentTemplate(payload, runtimeEmployee.id);
        if (result?.employee_id) await reportEmployeeTemplateSync(result);
        return;
      }
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
      const res = await apiFetch("/runtime/heartbeat", {
        method: "POST",
        body: JSON.stringify({
          status,
          status_reason: statusReason,
          agent: {
            timestamp: new Date().toISOString(),
            uptime_seconds: process.uptime(),
            gateway_ready: gatewayReady,
            runtime_image_version: String(imageVersion),
            openclaw_version: reportedOpenClawVersion,
            runtime_contract_version: String(runtimeContract),
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
      const res = await apiFetch("/runtime/commands?limit=10", { method: "GET" });
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
        const result = await applyAgentCommand(cmd);
        if (result?.employee_id && result?.components) await reportEmployeeTemplateSync(result);
        if (cmd?.status === "leased") await acknowledgeCommand(cmd, { status: "succeeded", retryable: false });
      } catch (err) {
        const retryable = err?.retryable === true || /gateway|disconnected|timeout|unavailable|ECONN/i.test(String(err?.message || err));
        if (cmd?.status === "leased") await acknowledgeCommand(cmd, { status: "failed", retryable, error: String(err?.message || err) });
      }
    }
  }

  async function acknowledgeCommand(command, result) {
    const res = await apiFetch(`/runtime/commands/${encodeURIComponent(command.id)}/ack`, {
      method: "POST",
      body: JSON.stringify(result),
    });
    if (!res.ok) throw new Error(`command acknowledgement failed: ${res.status}`);
  }

  async function reportEmployeeTemplateSync(result) {
    const status = result.overall_status === "active" ? "active" : "failed";
    const errors = Object.entries(result.components || {})
      .flatMap(([name, component]) => Array.isArray(component)
        ? component.filter((item) => item?.status === "failed").map((item) => `${name}:${item.error || "failed"}`)
        : component?.status === "failed" ? [`${name}:${component.error || "failed"}`] : [])
      .join("; ")
      .slice(0, 1000);
    await sendEvent("template_sync", {
      employee_id: result.employee_id,
      revision: result.template_version,
      status,
      ...(errors ? { error: errors } : {}),
    });
  }

  function start(detectedOpenClawVersion) {
    if (detectedOpenClawVersion) reportedOpenClawVersion = String(detectedOpenClawVersion);
    setTimeout(async () => {
      sendHeartbeat();
      sendEvent("instance_started", {
        version: reportedOpenClawVersion,
        image_version: String(imageVersion),
        runtime_contract_version: String(runtimeContract),
      });
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

  function managedEmployeeStatePath(agentId) {
    return safeAgentFilePath(agentWorkspace(workspaceDir, agentId), ".oneclaw-managed.json");
  }

  function loadManagedEmployeeState(agentId) {
    try {
      return JSON.parse(fs.readFileSync(managedEmployeeStatePath(agentId), "utf8"));
    } catch {
      return {};
    }
  }

  function atomicWriteFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(temporary, content, "utf8");
      fs.renameSync(temporary, filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  }

  function saveManagedEmployeeState(agentId, state) {
    atomicWriteFile(managedEmployeeStatePath(agentId), `${JSON.stringify(state, null, 2)}\n`);
  }

  async function syncEmployeeIdentity(payload, agentId) {
    const name = String(payload.bot_name || agentId).trim() || agentId;
    const model = String(payload.model || "").trim();
    const avatar = String(payload.avatar || "").trim();
    await callGatewayWithReconnectRetry("agents.update", {
      agentId,
      name,
      ...(model ? { model } : {}),
      ...(avatar ? { avatar } : {}),
    });
    const safeLine = (value) => String(value || "").replace(/[\r\n]+/g, " ").trim();
    const identity = [
      "# IDENTITY.md - Agent Identity",
      "",
      `- Name: ${safeLine(name)}`,
      ...(avatar ? [`- Avatar: ${safeLine(avatar)}`] : []),
      "",
    ].join("\n");
    await callGatewayWithReconnectRetry("agents.files.set", { agentId, name: "IDENTITY.md", content: identity });
  }

  async function reconcileEmployeeMemory(agentId, memoryFiles) {
    const workspace = agentWorkspace(workspaceDir, agentId);
    const previous = loadManagedEmployeeState(agentId);
    const desiredPaths = [];
    const failures = [];
    for (const file of Array.isArray(memoryFiles) ? memoryFiles : []) {
      const relativePath = String(file?.path || "").trim();
      if (!relativePath || typeof file.content !== "string") continue;
      try {
        const filePath = safeAgentFilePath(workspace, relativePath);
        atomicWriteFile(filePath, file.content);
        desiredPaths.push(relativePath);
      } catch (err) {
        failures.push(boundedComponentError(err));
      }
    }
    const desiredSet = new Set(desiredPaths);
    for (const relativePath of Array.isArray(previous.memory_files) ? previous.memory_files : []) {
      if (desiredSet.has(relativePath)) continue;
      try {
        fs.rmSync(safeAgentFilePath(workspace, relativePath), { force: true });
      } catch (err) {
        failures.push(boundedComponentError(err));
      }
    }
    return { previous, desiredPaths, failures };
  }

  function normalizedSkillSlugs(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))].sort();
  }

  function updateAgentSkillAllowlist(agentId, update) {
    const targetAgentId = String(agentId || "").trim();
    if (!targetAgentId) throw new Error("agent id is required for skill allowlist update");
    const configPath = path.join(stateDir || path.dirname(workspaceDir), "openclaw.json");
    if (!fs.existsSync(configPath)) throw new Error(`OpenClaw config is unavailable: ${configPath}`);
    let nextSkills = [];
    patchConfig(configPath, (config) => {
      if (!config.agents || typeof config.agents !== "object") config.agents = {};
      if (!Array.isArray(config.agents.list)) config.agents.list = [];
      let agent = config.agents.list.find((item) => item?.id === targetAgentId || item?.agentId === targetAgentId);
      if (!agent) {
        agent = { id: targetAgentId };
        config.agents.list.push(agent);
      }
      nextSkills = normalizedSkillSlugs(update(normalizedSkillSlugs(agent.skills)));
      agent.skills = nextSkills;
    });
    return nextSkills;
  }

  function setAgentSkillAllowlist(agentId, skills) {
    return updateAgentSkillAllowlist(agentId, () => skills);
  }

  function readAgentSkillAllowlist(agentId) {
    const targetAgentId = String(agentId || "").trim();
    const configPath = path.join(stateDir || path.dirname(workspaceDir), "openclaw.json");
    if (!targetAgentId || !fs.existsSync(configPath)) return [];
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const agent = config?.agents?.list?.find((item) => item?.id === targetAgentId || item?.agentId === targetAgentId);
    return normalizedSkillSlugs(agent?.skills);
  }

  function addAgentSkillToAllowlist(agentId, slug) {
    return updateAgentSkillAllowlist(agentId, (skills) => [...skills, slug]);
  }

  function removeAgentSkillFromAllowlist(agentId, slug) {
    return updateAgentSkillAllowlist(agentId, (skills) => skills.filter((value) => value !== slug));
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
    if (command?.type !== "apply_template") throw new Error(`unsupported runtime command: ${command?.type || "unknown"}`);
    const employeeId = String(payload.employee_id || payload.employeeId || "").trim();
    const templateId = String(payload.template_id || payload.templateId || "").trim();
    const hasTemplateContent = Boolean(
      payload.soul_md ||
      payload.soulMd ||
      payload.system_prompt ||
      Array.isArray(payload.memory_files) ||
      Array.isArray(payload.memoryFiles) ||
      Array.isArray(payload.skill_requirements) ||
      Array.isArray(payload.skill_specs) ||
      Array.isArray(payload.skills) ||
      Array.isArray(payload.cron_tasks),
    );
    if (employeeId && hasTemplateContent) {
      return applyEmployeeAgentTemplate(payload, employeeId);
    }
    if (!hasTemplateContent && (employeeId || templateId)) {
      const runtimeEmployee = await fetchRuntimeEmployee(employeeId);
      if (runtimeEmployee) {
        const runtimePayload = runtimeEmployeeTemplatePayload(runtimeEmployee);
        const resolvedPayload = {
          ...runtimePayload,
          ...payload,
          memory_files: payload.memory_files || runtimePayload.memory_files,
        };
        return applyEmployeeAgentTemplate(resolvedPayload, runtimeEmployee.id);
      }
    }
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
    applyMemoryFiles(payload.memory_files, mainWorkspace);
  }

  async function fetchRuntimeEmployee(employeeId = "") {
    const res = await apiFetch("/runtime/personality", { method: "GET" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `runtime personality fetch failed: ${res.status}`);
    }
    const defaultModel = String(data?.workspace?.default_model || "");
    const employees = (Array.isArray(data.employees) ? data.employees : [])
      .map((employee) => ({ ...employee, model: employee?.model || defaultModel }));
    if (employeeId) {
      return employees.find((employee) => employee?.id === employeeId) || null;
    }
    return employees.find((employee) => employee?.kind === "main") || employees[0] || null;
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
        identity: { status: "skipped" },
        soul: { status: "skipped" },
        memory: { status: "skipped" },
        skills: [],
        cron_tasks: [],
      },
    };

    try {
      await syncEmployeeIdentity(payload, agentId);
      result.components.identity = { status: "active" };
    } catch (err) {
      result.components.identity = { status: "failed", error: boundedComponentError(err) };
    }

    const soulMd = String(payload.soul_md || payload.soulMd || "").trim();
    const role = String(payload.role || "").trim();
    try {
      const content = [soulMd, role ? `## Role\n${role}` : ""].filter(Boolean).join("\n\n");
      await callGatewayWithReconnectRetry("agents.files.set", { agentId, name: "SOUL.md", content });
      result.components.soul = { status: "active" };
    } catch (err) {
      const error = boundedComponentError(err);
      result.components.soul = { status: "failed", error };
    }

    const memoryFiles = payload.memory_files || payload.memoryFiles || [];
    const memoryResult = await reconcileEmployeeMemory(agentId, memoryFiles);
    result.components.memory = memoryResult.failures.length > 0
      ? { status: "failed", error: memoryResult.failures.join("; ").slice(0, 500) }
      : { status: "active" };

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
        result.components.skills.push({
          slug,
          status: "active",
        });
        await sendEvent("skill_status", {
          employee_id: employeeId,
          slug,
          status: "active",
        });
      } catch (err) {
        const error = boundedComponentError(err);
        result.components.skills.push({
          slug,
          status: "failed",
          required: requirement?.required === true,
          error,
        });
        await sendEvent("skill_status", {
          employee_id: employeeId,
          slug,
          status: "failed",
          error,
        });
        console.warn(`[command] employee skill ${slug} sync failed: ${error}`);
      }
    }

    if (Array.isArray(payload.assigned_skill_slugs)) {
      const failedSkills = new Set(result.components.skills
        .filter((skill) => skill.status !== "active")
        .map((skill) => skill.slug));
      const assignedSkills = normalizedSkillSlugs(payload.assigned_skill_slugs)
        .filter((slug) => !failedSkills.has(slug));
      setAgentSkillAllowlist(agentId, assignedSkills);
    }

    const cronTasks = Array.isArray(payload.cron_tasks) ? payload.cron_tasks : [];
    const desiredCronIds = cronTasks.map((task) => String(task?.id || task?.task_id || "").trim()).filter(Boolean);
    const desiredCronSet = new Set(desiredCronIds);
    for (const staleTaskId of Array.isArray(memoryResult.previous.cron_task_ids) ? memoryResult.previous.cron_task_ids : []) {
      if (desiredCronSet.has(staleTaskId)) continue;
      try {
        await deleteCronTask({ task_id: staleTaskId });
      } catch (err) {
        result.components.cron_tasks.push({ task_id: staleTaskId, status: "failed", error: boundedComponentError(err) });
      }
    }
    for (const cronTask of cronTasks) {
      const taskId = String(cronTask?.id || cronTask?.task_id || "").trim();
      if (!taskId) continue;
      try {
        const taskPayload = runtimeCronCommandPayload(cronTask, agentId);
        const nativeTaskId = await upsertCronTask(taskPayload);
        const status = taskPayload.enabled === false ? "paused" : "active";
        result.components.cron_tasks.push({
          task_id: taskId,
          status,
        });
        await sendEvent("cron_status", {
          employee_id: employeeId,
          task_id: taskId,
          openclaw_task_id: nativeTaskId,
          status,
        });
      } catch (err) {
        const error = boundedComponentError(err);
        result.components.cron_tasks.push({
          task_id: taskId,
          status: "failed",
          error,
        });
      }
    }

    const componentResults = [
      result.components.identity,
      result.components.soul,
      result.components.memory,
      ...result.components.skills,
      ...result.components.cron_tasks,
    ];
    if (componentResults.some((component) => component?.status === "failed" || component?.status === "needs_configuration")) {
      result.overall_status = "degraded";
    }
    saveManagedEmployeeState(agentId, {
      ...memoryResult.previous,
      employee_id: employeeId,
      memory_files: memoryResult.desiredPaths,
      cron_task_ids: desiredCronIds,
      updated_at: new Date().toISOString(),
    });
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
    const model = String(payload.model || payload.suggested_model || "clawrouters/auto").trim() || "clawrouters/auto";
    const createFrame = await callGateway("agents.create", {
      name: stableName,
      workspace,
      model,
      emoji: String(payload.emoji || ""),
      avatar: String(payload.avatar || ""),
    });
    if (createFrame?.agentId) return createFrame.agentId;
    if (createFrame?.result?.agentId) return createFrame.result.agentId;
    if (createFrame?.payload?.agentId) return createFrame.payload.agentId;
    throw new Error(`agents.create did not return an agent id for ${stableName}`);
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
      const agentId = requiredEmployeeAgentId(payload);
      const spec = await resolveRuntimeSkillSpec({
        slug,
        source: payload.source,
        version: payload.version,
        force: payload.force,
      });
      await installSkillForAgent(spec, agentId, payload.credentials);
      addAgentSkillToAllowlist(agentId, slug);
      if (employeeId) {
        await sendEvent("skill_status", {
          employee_id: employeeId,
          slug,
          status: "active",
        });
      }
      console.log(`[command] installed skill ${slug} for ${agentId}`);
    } catch (err) {
      if (employeeId) {
        await sendEvent("skill_status", {
          employee_id: employeeId,
          slug,
          status: "failed",
          error: boundedComponentError(err),
        });
      }
      console.error(`[command] install skill ${slug} failed: ${err.message}`);
      throw err;
    }
  }

  function requiredEmployeeAgentId(payload) {
    const agentId = String(payload?.openclaw_agent_id || payload?.agent_id || payload?.agentId || "").trim();
    if (!agentId) throw new Error("openclaw_agent_id is required for employee skill command");
    return agentId;
  }

  async function resolveRuntimeSkillSpec(value) {
    const inline = typeof value === "string" ? { slug: value } : (value || {});
    const slug = String(inline.slug || inline.skill_slug || "").trim();
    if (!slug) throw new Error("skill slug is required");
    const res = await apiFetch(`/runtime/skills/${encodeURIComponent(slug)}`, { method: "GET" });
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
      const wasAllowed = readAgentSkillAllowlist(agentId).includes(slug);
      addAgentSkillToAllowlist(agentId, slug);
      try {
        const skill = await waitForBuiltinSkillStatus(slug, agentId);
        if (!skill) {
          throw new Error(`builtin skill ${slug} is not available in this runtime`);
        }
        const unavailableReasons = skillUnavailableReasons(skill);
        if (unavailableReasons.length > 0) {
          throw new Error(`builtin skill ${slug} is not usable: ${unavailableReasons.join("; ")}`);
        }
        if (credentials && Object.keys(credentials).length > 0) {
          await callGateway("skills.update", { skillKey: slug, ...credentials });
        }
      } catch (err) {
        if (!wasAllowed) removeAgentSkillFromAllowlist(agentId, slug);
        throw err;
      }
      console.log(`[command] builtin skill ${slug} available for ${agentId}`);
      return;
    }
    if (typeof runCmd !== "function" || typeof clawArgs !== "function" || !OPENCLAW_NODE) {
      throw new Error("OpenClaw CLI unavailable");
    }
    if (source === "custom") {
      const workspaceRoot = workspaceDir || process.env.OPENCLAW_WORKSPACE_DIR || "/data/workspace";
      const tempBase = path.join(workspaceRoot, ".tmp");
      fs.mkdirSync(tempBase, { recursive: true, mode: 0o700 });
      fs.chmodSync(tempBase, 0o700);
      const tempRoot = fs.mkdtempSync(path.join(tempBase, "oneclaw-skill-"));
      const zipPath = path.join(tempRoot, `${slug}.zip`);
      const extractPath = path.join(tempRoot, "contents");
      try {
        const res = await apiFetch(`/runtime/skills/${encodeURIComponent(slug)}/archive`, { method: "GET" });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `custom skill ${slug} download failed: ${res.status}`);
        }
        fs.mkdirSync(extractPath, { recursive: true });
        fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
        const unpack = await runCmd("unzip", ["-o", zipPath, "-d", extractPath]);
        if (unpack.code !== 0) throw new Error(unpack.output || `failed to extract custom skill ${slug}`);
        const skillRoot = resolveExtractedSkillRoot(extractPath);
        const args = ["skills", "install", skillRoot, "--as", slug, "--agent", agentId];
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

  async function waitForBuiltinSkillStatus(slug, agentId) {
    const attempts = Math.max(1, Number(skillStatusAttempts) || 1);
    let lastConnectionError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await gatewayRpc.waitUntilConnected?.(10_000);
        const frame = await callGateway("skills.status", { agentId });
        const skills = frame?.skills || frame?.result?.skills || frame?.payload?.skills || [];
        const skill = Array.isArray(skills)
          ? skills.find((entry) => entry?.name === slug || entry?.slug === slug || entry?.skillKey === slug)
          : null;
        lastConnectionError = undefined;
        if (!skill || skill.blockedByAgentFilter !== true || attempt === attempts - 1) return skill;
      } catch (err) {
        const isConnectionError = /gateway|disconnected|timeout|unavailable|ECONN/i.test(String(err?.message || err));
        if (!isConnectionError || attempt === attempts - 1) throw err;
        lastConnectionError = err;
      }
      if (skillStatusRetryMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, skillStatusRetryMs));
      }
    }
    if (lastConnectionError) throw lastConnectionError;
    return null;
  }

  async function removeEmployeeSkill(payload) {
    const slug = String(payload.skill_slug || payload.skillSlug || payload.slug || "").trim();
    if (!slug) return;
    const employeeId = String(payload.employee_id || payload.employeeId || "").trim();
    const agentId = requiredEmployeeAgentId(payload);
    const skillDir = await resolveSkillDir(agentId, slug);
    if (skillDir) fs.rmSync(skillDir, { recursive: true, force: true });
    removeAgentSkillFromAllowlist(agentId, slug);
    if (employeeId) {
      await sendEvent("skill_status", {
        employee_id: employeeId,
        slug,
        status: "removed",
      });
    }
    console.log(`[command] removed skill ${slug} for ${agentId}`);
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
      throw new Error("gateway rpc unavailable; cannot sync cron task");
    }
    const task = normalizeCronTaskPayload(
      payload?.task || payload,
      payload?.openclaw_agent_id || payload?.agent_id || payload?.agentId,
    );
    if (!task?.managedId) throw new Error("invalid cron task payload: managed task id is required");
    try {
      await gatewayRpc.waitUntilConnected?.(10_000);
      const nativeId = await resolveCronNativeId(task.managedId);
      if (nativeId) {
        const { managedId, ...patch } = task;
        await callGateway("cron.update", { id: nativeId, patch });
        console.log(`[command] updated cron task ${task.managedId} -> ${nativeId}`);
        return nativeId;
      } else {
        const { managedId, ...job } = task;
        const created = await callGateway("cron.add", job);
        const createdId = created?.id || created?.job?.id || created?.result?.id;
        if (!createdId) throw new Error("cron.add did not return a task id");
        saveCronNativeId(managedId, createdId);
        console.log(`[command] added cron task ${managedId} -> ${createdId}`);
        return createdId;
      }
    } catch (err) {
      console.error(`[command] cron task upsert failed: ${err.message}`);
      await sendEvent("runtime_command_failed", { type: "upsert_cron_task", task_id: task.managedId, error: err.message });
      throw err;
    }
  }

  async function deleteCronTask(payload) {
    if (!gatewayRpc?.rpcGateway) {
      throw new Error("gateway rpc unavailable; cannot delete cron task");
    }
    const taskId = String(payload?.task_id || payload?.taskId || payload?.task?.id || "").trim();
    if (!taskId) throw new Error("invalid cron task payload: managed task id is required");
    try {
      await gatewayRpc.waitUntilConnected?.(10_000);
      const nativeId = await resolveCronNativeId(taskId);
      if (!nativeId) return;
      await callGateway("cron.remove", { id: nativeId });
      deleteCronNativeId(taskId);
      console.log(`[command] removed cron task ${taskId} -> ${nativeId}`);
    } catch (err) {
      console.warn(`[command] cron task remove failed: ${err.message}`);
      // 必须让上层按 retryable=true 回执；吞掉异常会把容器内仍存在的任务误报为删除成功。
      throw err;
    }
  }

  async function runCronTask(payload) {
    if (!gatewayRpc?.rpcGateway) {
      throw new Error("gateway rpc unavailable; cannot run cron task");
    }
    const taskId = String(payload?.task_id || payload?.taskId || payload?.task?.id || "").trim();
    if (!taskId) throw new Error("invalid cron task payload: managed task id is required");
    try {
      await gatewayRpc.waitUntilConnected?.(10_000);
      const nativeId = await resolveCronNativeId(taskId);
      if (!nativeId) return;
      await callGateway("cron.run", { id: nativeId, mode: "force" });
      console.log(`[command] ran cron task ${taskId} -> ${nativeId}`);
    } catch (err) {
      console.error(`[command] cron task run failed: ${err.message}`);
      throw err;
    }
  }

  async function callGateway(method, params = {}, opts = {}) {
    const frame = await gatewayRpc.rpcGateway(method, params);
    if (frame?.ok === false && !opts.tolerateError) {
      throw new Error(frame.error?.message || frame.error?.code || `${method} failed`);
    }
    return frame?.payload || frame?.result || frame;
  }

  async function callGatewayWithReconnectRetry(method, params = {}, opts = {}) {
    try {
      return await callGateway(method, params, opts);
    } catch (err) {
      const message = String(err?.message || err || "");
      if (!/gateway ws closed|not connected|disconnected|econnrefused|gateway starting|rpc timeout/i.test(message)) {
        throw err;
      }
      console.warn(`[gateway-rpc] ${method} interrupted; waiting for reconnect before retry`);
      await gatewayRpc.waitUntilConnected?.(30_000);
      return callGateway(method, params, opts);
    }
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

  return {
    start, stop, sendHeartbeat, pollCommands, sendEvent, trackMessage,
    fetchPersonality, applyPersonality, reconcileAllEmployees, applyTemplateFromEnv,
    getCachedPersonality: () => cachedPersonality,
    getCachedEmployees: () => cachedEmployees,
  };

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
      await startChannelBindingSession(payload);
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

  async function startChannelBindingSession(payload) {
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
    if (previous?.sessionId === sessionId && !previous.cancelled) {
      return;
    }
    if (previous) {
      cancelChannelBindingSession(previous);
    }

    const runtimeRestartRequired = ensureQrChannelRuntimeConfig(channel, payload);
    if (runtimeRestartRequired) {
      await restartRuntimeAfterChannelChange();
    }

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
    if (!manifestEntry?.reconcileShape) return false;
    const configState = payload?.state?.config || payload?.config || {};
    const access = configState?.access;
    const runtimePolicy = access ? buildRuntimeChannelAccessPolicy(access) : {};
    const shape = {
      ...manifestEntry.reconcileShape(process.env),
      ...runtimePolicy,
    };
    // 正常部署由 Go 后端通过 WECHAT_ENABLED/WHATSAPP_ENABLED 启用；这里作为老容器或异常配置的兜底。
    // 若绑定时 channel/plugin 缺失，OpenClaw CLI 会停在交互式“Install plugin?”提示，导致拿不到二维码。
    const configPath = stateDir ? path.join(stateDir, "openclaw.json") : "";
    let runtimeRestartRequired = false;
    if (configPath && fs.existsSync(configPath)) {
      try {
        const current = JSON.parse(fs.readFileSync(configPath, "utf8"));
        const channelEnabled = current?.channels?.[runtimeChannel]?.enabled === true;
        const pluginEnabled = !manifestEntry.pluginId || current?.plugins?.entries?.[manifestEntry.pluginId]?.enabled === true;
        runtimeRestartRequired = !channelEnabled || !pluginEnabled;
      } catch (err) {
        console.warn(`[channel-bind] failed to inspect ${runtimeChannel} config: ${err.message}`);
        runtimeRestartRequired = true;
      }
    }
    setChannelConfig(runtimeChannel, shape, {
      stateDir: stateDir || path.dirname(workspaceDir),
    });
    return runtimeRestartRequired;
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
      const data = await repairFetch("whatsapp-login/start", "POST", {
        accountId: session.employeeId,
      });
      if (data?.preparing !== true && data?.status !== "starting") {
        session.started = true;
      }
      return data;
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

function normalizeCronTaskPayload(raw, fallbackAgentId = "") {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || raw.task_id || raw.taskId || "").trim();
  if (!id) return null;
  // Go API 的员工聚合与运行时命令使用扁平业务字段；模板内部和 OpenClaw RPC 使用嵌套字段。
  // 在唯一入口完成转换，避免创建、更新和人格全量同步形成三套不一致的计划任务语义。
  const apiTask = raw.schedule_kind || raw.every_seconds || raw.cron_expr || raw.prompt || raw.delivery_mode
    ? runtimeCronCommandPayload(raw, fallbackAgentId || raw.openclaw_agent_id || raw.agent_id || raw.agentId || "main")
    : raw;
  return {
    managedId: id,
    name: managedCronTaskName(id, apiTask.name || id),
    description: String(apiTask.description || "Managed by OneClaw").trim(),
    schedule: normalizeCronSchedule(apiTask.schedule),
    sessionTarget: apiTask.sessionTarget || apiTask.session_target || "isolated",
    wakeMode: apiTask.wakeMode || apiTask.wake_mode || "now",
    payload: normalizeCronPayload(apiTask.payload),
    delivery: normalizeCronDelivery(apiTask.delivery),
    agentId: apiTask.agentId || apiTask.agent_id || fallbackAgentId || "main",
    enabled: apiTask.enabled !== false,
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

function runtimeEmployeePersonality(employee) {
  if (!employee) return null;
  const personality = employee.personality && typeof employee.personality === "object"
    ? employee.personality
    : {};
  return {
    ...personality,
    botName: employee.name,
    systemPrompt: employee.system_prompt,
    greeting: employee.greeting,
    avatarUrl: employee.avatar_url,
    runtimeEmployee: employee,
  };
}

function runtimeEmployeeTemplatePayload(employee) {
  const skills = Array.isArray(employee?.skills) ? employee.skills : [];
  return {
    employee_id: employee?.id,
    openclaw_agent_id: employee?.openclaw_agent_id || (employee?.kind === "main" ? "main" : ""),
    template_version: Number(employee?.template_revision || 1),
    bot_name: employee?.name,
    avatar: employee?.avatar_url || "",
    model: employee?.model || "",
    soul_md: employee?.system_prompt || "",
    role: employee?.role || "",
    memory_files: Array.isArray(employee?.memory_files) ? employee.memory_files : [],
    skill_requirements: skills.map((skill) => ({
      slug: skill.slug,
      source: skill.source,
      required: false,
    })),
    assigned_skill_slugs: skills.map((skill) => skill.slug),
    cron_tasks: Array.isArray(employee?.cron_tasks) ? employee.cron_tasks : [],
  };
}

function runtimeCronCommandPayload(task, agentId) {
  let schedule;
  if (task.schedule_kind === "every") {
    schedule = {
      kind: "every",
      everyMs: Number(task.every_seconds || 60) * 1000,
    };
  } else {
    schedule = {
      kind: "cron",
      expr: String(task.cron_expr || "0 9 * * *"),
      ...(task.timezone ? { tz: String(task.timezone) } : {}),
    };
  }
  let delivery = {
    mode: "none",
  };
  if (task.delivery_mode === "external") {
    delivery = {
      mode: "announce",
      ...(task.delivery_channel ? { channel: String(task.delivery_channel) } : {}),
      ...(task.delivery_to ? { to: String(task.delivery_to) } : {}),
    };
  }
  return {
    id: task.id || task.task_id,
    name: task.name,
    description: "由 OneClaw 管理",
    schedule,
    payload: {
      kind: "agentTurn",
      message: String(task.prompt || ""),
    },
    delivery,
    agent_id: agentId,
    enabled: task.enabled !== false && task.is_enabled !== false,
  };
}

function normalizeTemplate(template) {
  if (!template) return null;
  return {
    ...template,
    templateId: template.templateId || template.template_id || template.id,
    soulMd: template.soulMd || template.soul_md || template.system_prompt,
    memoryFiles: template.memoryFiles || template.memory_files,
    suggestedModel: template.suggestedModel || template.suggested_model,
  };
}
