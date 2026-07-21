import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { agentWorkspace, migrateAgentWorkspaces, safeAgentFilePath } from "../src/agents/workspace.js";

test("agentWorkspace gives main and hired agents canonical directories", () => {
  assert.equal(agentWorkspace("/data/workspace", "main"), "/data/workspace/agents/main");
  assert.equal(agentWorkspace("/data/workspace", "oneclaw-emp-1"), "/data/workspace/agents/oneclaw-emp-1");
  assert.throws(() => agentWorkspace("/data/workspace", "../escape"), /invalid agent id/);
});

test("safeAgentFilePath allows memory fragments but rejects traversal", () => {
  const workspace = "/data/workspace/agents/main";
  assert.equal(safeAgentFilePath(workspace, "memory/profile.md"), "/data/workspace/agents/main/memory/profile.md");
  assert.throws(() => safeAgentFilePath(workspace, "../secret"), /unsafe agent file path/);
  assert.throws(() => safeAgentFilePath(workspace, "/etc/passwd"), /unsafe agent file path/);
});

test("migrateAgentWorkspaces moves legacy main and hired files idempotently", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-workspaces-"));
  const configPath = path.join(root, "openclaw.json");
  fs.writeFileSync(path.join(root, "SOUL.md"), "legacy main");
  fs.mkdirSync(path.join(root, "agents", "emp-1"), { recursive: true });
  fs.writeFileSync(path.join(root, "agents", "emp-1", "SOUL.md"), "legacy hired");
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { defaults: { workspace: root }, list: [{ id: "oneclaw-emp-1", workspace: path.join(root, "agents", "emp-1") }] },
  }));

  migrateAgentWorkspaces({ workspaceRoot: root, configPath });
  migrateAgentWorkspaces({ workspaceRoot: root, configPath });

  assert.equal(fs.readFileSync(path.join(root, "agents", "main", "SOUL.md"), "utf8"), "legacy main");
  assert.equal(fs.readFileSync(path.join(root, "agents", "oneclaw-emp-1", "SOUL.md"), "utf8"), "legacy hired");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(cfg.agents.defaults.workspace, path.join(root, "agents", "main"));
  assert.deepEqual(
    cfg.agents.list.find((agent) => agent.id === "main"),
    { id: "main", default: true, workspace: path.join(root, "agents", "main") },
  );
  assert.equal(
    cfg.agents.list.find((agent) => agent.id === "oneclaw-emp-1").workspace,
    path.join(root, "agents", "oneclaw-emp-1"),
  );
});
