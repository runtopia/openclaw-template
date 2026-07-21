import fs from "node:fs";
import path from "node:path";

const AGENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function agentWorkspace(workspaceRoot, agentId) {
  const root = path.resolve(String(workspaceRoot || ""));
  const id = String(agentId || "").trim();
  if (!id || !AGENT_ID_PATTERN.test(id)) throw new Error(`invalid agent id: ${id}`);
  return path.join(root, "agents", id);
}

export function safeAgentFilePath(workspace, relativePath) {
  const root = path.resolve(String(workspace || ""));
  const name = String(relativePath || "");
  if (!name || name.includes("\0") || path.isAbsolute(name)) throw new Error(`unsafe agent file path: ${name}`);
  const resolved = path.resolve(root, name);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe agent file path: ${name}`);
  return resolved;
}

function filesEqual(left, right) {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.isFile() && b.isFile() && a.size === b.size && fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
}

function moveEntry(source, destination, conflictRoot, relativePath) {
  if (!fs.existsSync(source)) return;
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    return;
  }
  const sourceStat = fs.statSync(source);
  const destinationStat = fs.statSync(destination);
  if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
    for (const name of fs.readdirSync(source)) {
      moveEntry(path.join(source, name), path.join(destination, name), conflictRoot, path.join(relativePath, name));
    }
    if (fs.readdirSync(source).length === 0) fs.rmdirSync(source);
    return;
  }
  if (filesEqual(source, destination)) {
    fs.rmSync(source, { recursive: true, force: true });
    return;
  }
  const conflict = safeAgentFilePath(conflictRoot, relativePath);
  fs.mkdirSync(path.dirname(conflict), { recursive: true });
  if (!fs.existsSync(conflict)) fs.renameSync(source, conflict);
  else fs.rmSync(source, { recursive: true, force: true });
  console.warn(`[workspace] migration conflict preserved at ${conflict}`);
}

export function migrateAgentWorkspaces({ workspaceRoot, configPath }) {
  const root = path.resolve(workspaceRoot);
  fs.mkdirSync(path.join(root, "agents"), { recursive: true });
  const mainWorkspace = agentWorkspace(root, "main");
  const mainConflict = path.join(root, ".migration-conflicts", "main");
  fs.mkdirSync(mainWorkspace, { recursive: true });

  const excluded = new Set(["agents", ".migration-conflicts"]);
  for (const name of fs.readdirSync(root)) {
    const source = path.join(root, name);
    if (excluded.has(name) || path.resolve(source) === path.resolve(configPath)) continue;
    moveEntry(source, path.join(mainWorkspace, name), mainConflict, name);
  }

  if (!configPath || !fs.existsSync(configPath)) return { mainWorkspace, migratedAgents: [] };
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!cfg.agents || typeof cfg.agents !== "object") cfg.agents = {};
  if (!cfg.agents.defaults || typeof cfg.agents.defaults !== "object") cfg.agents.defaults = {};
  cfg.agents.defaults.workspace = mainWorkspace;
  if (!Array.isArray(cfg.agents.list)) cfg.agents.list = [];
  let mainAgent = cfg.agents.list.find((agent) => String(agent?.id || agent?.agentId || "").trim() === "main");
  if (!mainAgent) {
    mainAgent = { id: "main" };
    cfg.agents.list.unshift(mainAgent);
  }
  // OneClaw 的主员工固定对应 main；显式注册后 agents.update/files.set 在首次开通即可使用。
  mainAgent.id = "main";
  mainAgent.default = true;
  mainAgent.workspace = mainWorkspace;
  for (const agent of cfg.agents.list) {
    if (agent !== mainAgent && agent?.default === true) delete agent.default;
  }
  const migratedAgents = [];
  for (const agent of Array.isArray(cfg.agents.list) ? cfg.agents.list : []) {
    const agentId = String(agent?.id || agent?.agentId || "").trim();
    if (!agentId || agentId === "main" || !AGENT_ID_PATTERN.test(agentId)) continue;
    const destination = agentWorkspace(root, agentId);
    const configured = typeof agent.workspace === "string" ? path.resolve(agent.workspace) : "";
    const legacyId = agentId.startsWith("oneclaw-") ? agentId.slice("oneclaw-".length) : "";
    const legacy = legacyId ? agentWorkspace(root, legacyId) : "";
    const source = configured && configured !== destination ? configured : legacy;
    if (source && source !== destination && fs.existsSync(source)) {
      moveEntry(source, destination, path.join(root, ".migration-conflicts", agentId), "workspace");
      migratedAgents.push(agentId);
    }
    fs.mkdirSync(destination, { recursive: true });
    agent.workspace = destination;
  }
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  return { mainWorkspace, migratedAgents };
}
