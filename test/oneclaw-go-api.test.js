import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createOneclawIntegration, normalizeOneclawApiUrl } from "../src/integration/oneclaw.js";

function makeWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-go-api-"));
}

function withFetch(handler) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls);
  };
  return () => {
    globalThis.fetch = originalFetch;
    return calls;
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("normalizes OneClaw Go API base URL to /api/v1", () => {
  assert.equal(normalizeOneclawApiUrl("https://oneclaw.example.com"), "https://oneclaw.example.com/api/v1");
  assert.equal(normalizeOneclawApiUrl("https://oneclaw.example.com/api"), "https://oneclaw.example.com/api/v1");
  assert.equal(normalizeOneclawApiUrl("https://oneclaw.example.com/api/v1/"), "https://oneclaw.example.com/api/v1");
});

test("heartbeat sends Go API snake_case payload and applies queued template command", async () => {
  const workspaceDir = makeWorkspace();
  const restoreFetch = withFetch((url, opts) => {
    assert.equal(url, "https://oneclaw.example.com/api/v1/agent/heartbeat");
    assert.equal(opts.headers.Authorization, "Bearer secret-1");
    const body = JSON.parse(opts.body);
    assert.equal(body.instance_id, "runtime-1");
    assert.equal(body.status, "healthy");
    assert.equal(body.status_reason, "gateway_ready");
    assert.equal(body.agent.gateway_ready, true);
    assert.equal(body.agent.platforms.telegram, true);
    return jsonResponse({
      instance_id: "runtime-1",
      status: "running",
      last_heartbeat: "2026-07-06T12:00:00Z",
      commands: [{
        id: "cmd-1",
        type: "apply_template",
        payload: {
          soul_md: "You are a Go-backed assistant.",
          memory_files: [{ path: "memory/profile.md", content: "hello" }],
        },
      }],
    });
  });
  const originalTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "telegram-token";

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.sendHeartbeat();
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = originalTelegramToken;
    restoreFetch();
  }

  assert.equal(fs.readFileSync(path.join(workspaceDir, "agents/main/SOUL.md"), "utf8"), "You are a Go-backed assistant.");
  assert.equal(fs.readFileSync(path.join(workspaceDir, "agents/main/memory/profile.md"), "utf8"), "hello");
});

test("employee template command syncs an OpenClaw agent workspace", async () => {
  const workspaceDir = makeWorkspace();
  const rpcCalls = [];
  const runCalls = [];
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === "agents.list") return { ok: true, payload: { agents: [] } };
      if (method === "agents.create") {
        return { ok: true, payload: { agentId: "oneclaw-emp-1" } };
      }
      if (method === "agents.files.set") {
        return { ok: true, payload: { ok: true } };
      }
      if (method === "agents.update") return { ok: true, payload: { ok: true } };
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  const restoreFetch = withFetch((url) => {
    if (url.includes("/agent/skills/github")) return jsonResponse({ slug: "github", source: "clawhub" });
    assert.equal(url, "https://oneclaw.example.com/api/v1/agent/heartbeat");
    return jsonResponse({
      instance_id: "runtime-1",
      status: "running",
      last_heartbeat: "2026-07-06T12:00:00Z",
      commands: [{
        id: "cmd-employee-template",
        type: "apply_template",
        payload: {
          employee_id: "emp-1",
          bot_name: "程序员助理",
          avatar: "👨‍💻",
          soul_md: "You are a developer assistant.",
          memory_files: [{ path: "memory/dev.md", content: "dev notes" }],
          skill_specs: [{ slug: "github", source: "clawhub" }],
          suggested_model: "clawrouters/code",
        },
      }],
    });
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayRpc,
      runCmd: async (cmd, args) => { runCalls.push({ cmd, args }); return { code: 0, output: "" }; },
      clawArgs: (args) => args,
      OPENCLAW_NODE: "node",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.sendHeartbeat();
  } finally {
    restoreFetch();
  }

  assert.equal(fs.existsSync(path.join(workspaceDir, "SOUL.md")), false);
  assert.equal(rpcCalls.find((call) => call.method === "agents.create").params.name, "oneclaw-emp-1");
  assert.equal(rpcCalls.find((call) => call.method === "agents.create").params.model, "clawrouters/auto");
  assert.deepEqual(
    rpcCalls.filter((call) => call.method === "agents.files.set").map((call) => call.params.name),
    ["SOUL.md"],
  );
  assert.equal(fs.readFileSync(path.join(workspaceDir, "agents/oneclaw-emp-1/memory/dev.md"), "utf8"), "dev notes");
  assert.equal(rpcCalls.some((call) => call.method === "agents.update"), false);
  assert.deepEqual(runCalls[0].args, ["skills", "install", "github", "--agent", "oneclaw-emp-1"]);
});

test("employee sync preserves content when an optional skill fails", async () => {
  const workspaceDir = makeWorkspace();
  const fileWrites = [];
  let acknowledgement;
  let syncResult;
  let skillResolutionCalls = 0;
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method, params) => {
      if (method === "agents.list") return { ok: true, payload: { agents: [{ id: "oneclaw-emp-degraded" }] } };
      if (method === "agents.files.set") {
        fileWrites.push(params);
        return { ok: true, payload: { ok: true } };
      }
      return { ok: true, payload: { ok: true } };
    },
  };
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url.includes("/agent/commands?")) {
      return jsonResponse({ commands: [{
        id: "cmd-degraded",
        status: "leased",
        type: "apply_template",
        payload: {
          employee_id: "emp-degraded",
          template_version: 2,
          soul_md: "You are a developer.",
          responsibilities: ["Review pull requests"],
          memory_files: [{ path: "memory/review.md", content: "Checklist" }],
          skill_requirements: [{ slug: "missing-skill", required: false, install_policy: "recommend" }],
        },
      }] });
    }
    if (url.includes("/agent/skills/missing-skill")) {
      skillResolutionCalls += 1;
      return jsonResponse({ error: "Skill not found" }, 404);
    }
    if (url.includes("/agent/commands/cmd-degraded/ack")) {
      acknowledgement = JSON.parse(opts.body);
      return jsonResponse({ acknowledged: true });
    }
    if (url.includes("/agent/employees/emp-degraded/template-sync")) {
      assert.equal(opts.method, "PUT");
      syncResult = JSON.parse(opts.body);
      return jsonResponse({ accepted: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayRpc,
      runCmd: async () => ({ code: 0, output: "" }),
      clawArgs: (args) => args,
      OPENCLAW_NODE: "node",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  assert.equal(skillResolutionCalls, 1);
  assert.equal(acknowledgement.status, "succeeded");
  assert.equal(syncResult.overall_status, "degraded");
  assert.equal(syncResult.components.skills[0].status, "failed");
  assert.match(fileWrites.find((write) => write.name === "SOUL.md").content, /ONECLAW:RESPONSIBILITIES:START/);
  assert.equal(fs.readFileSync(path.join(workspaceDir, "agents/oneclaw-emp-degraded/memory/review.md"), "utf8"), "Checklist");
});

test("employee template resolves builtin skills without sending them to ClawHub", async () => {
  const workspaceDir = makeWorkspace();
  const configPath = path.join(workspaceDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { list: [{ id: "oneclaw-emp-builtin", name: "Builtin Agent", model: "clawrouters/auto", skills: ["unassigned-builtin"] }] },
  }));
  const runCalls = [];
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method) => {
      if (method === "agents.list") return { ok: true, payload: { agents: [{ id: "oneclaw-emp-builtin" }] } };
      if (method === "agents.files.set") return { ok: true, payload: { ok: true } };
      if (method === "skills.status") return { ok: true, payload: { skills: [{ name: "github" }] } };
      return { ok: true, payload: { ok: true } };
    },
  };
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url.includes("/agent/commands?")) {
      return jsonResponse({ commands: [{
        id: "cmd-builtin",
        type: "apply_template",
        payload: {
          employee_id: "emp-builtin",
          assigned_skill_slugs: ["github"],
          skill_specs: [{ slug: "github", source: "clawhub" }],
        },
      }] });
    }
    if (url.includes("/agent/skills/github")) {
      assert.equal(opts.method, "GET");
      return jsonResponse({ slug: "github", source: "builtin" });
    }
    if (url.includes("/agent/commands/cmd-builtin/ack")) return jsonResponse({ acknowledged: true });
    if (url.includes("/agent/event")) return jsonResponse({ accepted: true });
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      stateDir: workspaceDir,
      workspaceDir,
      gatewayRpc,
      runCmd: async (_cmd, args) => { runCalls.push(args); return { code: 0, output: "" }; },
      clawArgs: (args) => args,
      OPENCLAW_NODE: "node",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  assert.equal(runCalls.some((args) => args[0] === "skills" && args[1] === "install"), false);
  const configured = JSON.parse(fs.readFileSync(configPath, "utf8")).agents.list[0];
  assert.deepEqual(configured.skills, ["github"]);
  assert.equal(configured.name, "Builtin Agent");
  assert.equal(configured.model, "clawrouters/auto");
});

test("builtin skill install fails when runtime status does not confirm the skill", async () => {
  const workspaceDir = makeWorkspace();
  let acknowledgement;
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method) => {
      if (method === "agents.list") return { ok: true, payload: { agents: [{ id: "oneclaw-emp-missing" }] } };
      if (method === "skills.status") return { ok: true, payload: { skills: [] } };
      return { ok: true, payload: { ok: true } };
    },
  };
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url.includes("/agent/commands?")) {
      return jsonResponse({ commands: [{
        id: "cmd-builtin-missing",
        status: "leased",
        type: "install_skill",
        payload: { employee_id: "emp-missing", skill_slug: "github", source: "clawhub" },
      }] });
    }
    if (url.includes("/agent/skills/github")) return jsonResponse({ slug: "github", source: "builtin" });
    if (url.includes("/agent/commands/cmd-builtin-missing/ack")) {
      acknowledgement = JSON.parse(opts.body);
      return jsonResponse({ acknowledged: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayRpc,
      runCmd: async () => ({ code: 0, output: "" }),
      clawArgs: (args) => args,
      OPENCLAW_NODE: "node",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  assert.equal(acknowledgement.status, "failed");
  assert.match(acknowledgement.error, /not available/);
});

test("builtin skill install rejects runtime entries that are not usable", async (t) => {
  const cases = [
    { label: "disabled", skill: { name: "github", disabled: true }, reason: /disabled/ },
    { label: "ineligible", skill: { name: "github", eligible: false }, reason: /ineligible/ },
    { label: "allowlist blocked", skill: { name: "github", blockedByAllowlist: true }, reason: /allowlist/ },
    { label: "agent filtered", skill: { name: "github", blockedByAgentFilter: true }, reason: /agent filter/ },
    { label: "model hidden", skill: { name: "github", modelVisible: false }, reason: /not visible to the model/ },
    { label: "missing requirements", skill: { name: "github", missing: { bins: ["gh"], env: ["GITHUB_TOKEN"] } }, reason: /missing requirements.*gh.*GITHUB_TOKEN/ },
  ];

  for (const testCase of cases) {
    await t.test(testCase.label, async () => {
      const workspaceDir = makeWorkspace();
      let acknowledgement;
      const gatewayRpc = {
        waitUntilConnected: async () => {},
        rpcGateway: async (method) => {
          if (method === "agents.list") return { ok: true, payload: { agents: [{ id: "oneclaw-emp-unusable" }] } };
          if (method === "skills.status") return { ok: true, payload: { skills: [testCase.skill] } };
          return { ok: true, payload: { ok: true } };
        },
      };
      const restoreFetch = withFetch((url, opts = {}) => {
        if (url.includes("/agent/commands?")) {
          return jsonResponse({ commands: [{
            id: "cmd-builtin-unusable",
            status: "leased",
            type: "install_skill",
            payload: { employee_id: "emp-unusable", skill_slug: "github" },
          }] });
        }
        if (url.includes("/agent/skills/github")) return jsonResponse({ slug: "github", source: "builtin" });
        if (url.includes("/agent/commands/cmd-builtin-unusable/ack")) {
          acknowledgement = JSON.parse(opts.body);
          return jsonResponse({ acknowledged: true });
        }
        throw new Error(`unexpected fetch: ${url}`);
      });

      try {
        const integration = createOneclawIntegration({
          apiUrl: "https://oneclaw.example.com/api",
          instanceId: "runtime-1",
          instanceSecret: "secret-1",
          workspaceDir,
          gatewayRpc,
          runCmd: async () => ({ code: 0, output: "" }),
          clawArgs: (args) => args,
          OPENCLAW_NODE: "node",
          isGatewayReady: () => true,
          isGatewayStarting: () => false,
        });
        await integration.pollCommands();
      } finally {
        restoreFetch();
        fs.rmSync(workspaceDir, { recursive: true, force: true });
      }

      assert.equal(acknowledgement.status, "failed");
      assert.match(acknowledgement.error, testCase.reason);
    });
  }
});

test("employee template downloads custom skills instead of sending their slug to ClawHub", async () => {
  const workspaceDir = makeWorkspace();
  const runCalls = [];
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method) => {
      if (method === "agents.list") return { ok: true, payload: { agents: [{ id: "oneclaw-emp-custom" }] } };
      return { ok: true, payload: { ok: true } };
    },
  };
  const restoreFetch = withFetch((url) => {
    if (url.includes("/agent/commands?")) {
      return jsonResponse({ commands: [{ id: "cmd-custom", type: "apply_template", payload: { employee_id: "emp-custom", skills: ["merge-upstream"] } }] });
    }
    if (url.includes("/agent/skills/merge-upstream/archive")) return new Response(Buffer.from("zip-data"), { status: 200 });
    if (url.includes("/agent/skills/merge-upstream")) return jsonResponse({ slug: "merge-upstream", source: "custom", version: "1.0.0" });
    if (url.includes("/agent/commands/cmd-custom/ack")) return jsonResponse({ acknowledged: true });
    if (url.includes("/agent/event")) return jsonResponse({ accepted: true });
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api", instanceId: "runtime-1", instanceSecret: "secret-1", workspaceDir, gatewayRpc,
      runCmd: async (cmd, args) => {
        runCalls.push({ cmd, args });
        if (cmd === "unzip") {
          const extractedRoot = args[args.indexOf("-d") + 1];
          fs.mkdirSync(path.join(extractedRoot, "merge-upstream"), { recursive: true });
          fs.writeFileSync(path.join(extractedRoot, "merge-upstream", "SKILL.md"), "---\nname: merge-upstream\n---\n");
        }
        return { code: 0, output: "" };
      },
      clawArgs: (args) => args, OPENCLAW_NODE: "node", isGatewayReady: () => true, isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  const install = runCalls.find((call) => call.args?.[0] === "skills" && call.args?.[1] === "install");
  assert.ok(install);
  assert.ok(install.args[2].startsWith(path.join(workspaceDir, ".tmp", "oneclaw-skill-")));
  assert.equal(path.basename(install.args[2]), "merge-upstream");
  assert.equal(install.args.includes("merge-upstream"), true);
  assert.equal(install.args.includes("--as"), true);
  assert.equal(runCalls.some((call) => call.args?.[2] === "merge-upstream"), false);
  assert.equal(fs.existsSync(install.args[2]), false);
});

test("leased cron command reports a retryable failed acknowledgement when gateway sync fails", async () => {
  const stateDir = makeWorkspace();
  let acknowledgement;
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method) => {
      if (method === "cron.list") return { ok: true, payload: { jobs: [] } };
      if (method === "cron.add") throw new Error("gateway unavailable");
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url.includes("/agent/commands?")) {
      return jsonResponse({ commands: [{
        id: "cmd-cron-failed",
        status: "leased",
        type: "upsert_cron_task",
        payload: { task: { id: "oneclaw-task-failed", name: "Failed task", schedule: { kind: "cron", expr: "0 9 * * *" }, payload: { kind: "agentTurn", message: "run" } } },
      }] });
    }
    if (url.includes("/agent/event")) return jsonResponse({ accepted: true });
    if (url.includes("/agent/commands/cmd-cron-failed/ack")) {
      acknowledgement = JSON.parse(opts.body);
      return jsonResponse({ acknowledged: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      stateDir,
      workspaceDir: path.join(stateDir, "workspace"),
      gatewayRpc,
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  assert.equal(acknowledgement.status, "failed");
  assert.equal(acknowledgement.retryable, true);
  assert.match(acknowledgement.error, /gateway unavailable/);
});

test("command polling applies employee template commands without waiting for heartbeat", async () => {
  const workspaceDir = makeWorkspace();
  const rpcCalls = [];
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === "agents.list") return { ok: true, payload: { agents: [] } };
      if (method === "agents.create") return { ok: true, payload: { agentId: "oneclaw-emp-poll" } };
      if (method === "agents.files.set") return { ok: true, payload: { ok: true } };
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  const restoreFetch = withFetch((url, opts = {}) => {
    assert.equal(opts.method, "GET");
    if (url.includes("/agent/skills/github")) return jsonResponse({ slug: "github", source: "clawhub" });
    assert.equal(url, "https://oneclaw.example.com/api/v1/agent/commands?instance_id=runtime-1&limit=10");
    return jsonResponse({
      instance_id: "runtime-1",
      commands: [{
        id: "cmd-polled-employee-template",
        type: "apply_template",
        payload: {
          employee_id: "emp-poll",
          template_id: "developer",
          bot_name: "程序员助理",
          soul_md: "Polled employee prompt.",
          memory_files: [{ path: "memory/polled.md", content: "poll notes" }],
        },
      }],
    });
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayRpc,
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  assert.equal(rpcCalls.find((call) => call.method === "agents.create").params.name, "oneclaw-emp-poll");
  assert.deepEqual(
    rpcCalls.filter((call) => call.method === "agents.files.set").map((call) => call.params.name),
    ["SOUL.md"],
  );
  assert.equal(fs.readFileSync(path.join(workspaceDir, "agents/oneclaw-emp-poll/memory/polled.md"), "utf8"), "poll notes");
});

test("leased command is acknowledged only after successful execution", async () => {
  const workspaceDir = makeWorkspace();
  let acknowledgements = 0;
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url.includes("/agent/commands?")) return jsonResponse({ commands: [{ id: "cmd-lease", type: "restart", status: "leased" }] });
    if (url.includes("/agent/commands/cmd-lease/ack")) {
      acknowledgements += 1;
      assert.deepEqual(JSON.parse(opts.body), { status: "succeeded", retryable: false });
      return jsonResponse({ acknowledged: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1", instanceId: "runtime-1", instanceSecret: "secret-1", workspaceDir,
      restartGateway: async () => ({ ok: true }), gatewayRpc: { restart() {} }, isGatewayReady: () => true, isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }
  assert.equal(acknowledgements, 1);
});

test("command polling installs and removes employee skills", async () => {
  const workspaceDir = makeWorkspace();
  const configPath = path.join(workspaceDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { list: [{ id: "oneclaw-emp-skill", name: "Skill Agent", model: "clawrouters/auto", skills: ["calendar"] }] },
  }));
  const baseDir = path.join(workspaceDir, "agents", "emp-skill", "skills");
  fs.mkdirSync(path.join(baseDir, "github"), { recursive: true });
  const rpcCalls = [];
  const runCalls = [];
  const allowlistsBeforeRemove = [];
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === "agents.create") return { ok: true, payload: { agentId: "oneclaw-emp-skill" } };
      if (method === "agents.list") return { ok: true, payload: { agents: [{ id: "oneclaw-emp-skill", name: "oneclaw-emp-skill" }] } };
      return { ok: true, payload: { ok: true } };
    },
  };
  const restoreFetch = withFetch((url, opts = {}) => {
    assert.equal(opts.method, "GET");
    if (url.includes("/agent/skills/github")) return jsonResponse({ slug: "github", source: "clawhub" });
    assert.equal(url, "https://oneclaw.example.com/api/v1/agent/commands?instance_id=runtime-1&limit=10");
    return jsonResponse({
      commands: [
        { id: "cmd-install", type: "install_skill", payload: { employee_id: "emp-skill", skill_slug: "github", source: "clawhub" } },
        { id: "cmd-remove", type: "remove_skill", payload: { employee_id: "emp-skill", skill_slug: "github" } },
      ],
    });
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      stateDir: workspaceDir,
      workspaceDir,
      gatewayRpc,
      runCmd: async (_cmd, args) => {
        runCalls.push(args);
        if (args.includes("list")) {
          allowlistsBeforeRemove.push(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.list[0].skills);
          return { code: 0, output: JSON.stringify({ baseDir }) };
        }
        return { code: 0, output: "ok" };
      },
      clawArgs: (args) => args,
      OPENCLAW_NODE: "node",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  assert.deepEqual(runCalls[0], ["skills", "install", "github", "--agent", "oneclaw-emp-skill"]);
  assert.deepEqual(runCalls[1], ["skills", "list", "--agent", "oneclaw-emp-skill", "--json"]);
  assert.deepEqual(allowlistsBeforeRemove, [["calendar", "github"]]);
  const configured = JSON.parse(fs.readFileSync(configPath, "utf8")).agents.list[0];
  assert.deepEqual(configured.skills, ["calendar"]);
  assert.equal(configured.name, "Skill Agent");
  assert.equal(configured.model, "clawrouters/auto");
  assert.equal(fs.existsSync(path.join(baseDir, "github")), false);
});

test("command polling restarts gateway and reports runtime logs", async () => {
  const workspaceDir = makeWorkspace();
  const eventBodies = [];
  let restartCalls = 0;
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/commands?instance_id=runtime-1&limit=10") {
      return jsonResponse({
        commands: [
          { id: "cmd-restart", type: "restart", payload: { reason: "manual" } },
          { id: "cmd-logs", type: "get_logs", payload: { lines: 2 } },
        ],
      });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/event") {
      eventBodies.push(JSON.parse(opts.body));
      return jsonResponse({ accepted: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      restartGateway: async () => {
        restartCalls += 1;
        return { ok: true, pending: true };
      },
      getGatewayLogs: () => ["line-1", "line-2", "line-3"],
      gatewayRpc: { restart: () => {} },
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  assert.equal(restartCalls, 1);
  assert.equal(eventBodies[0].event, "runtime_command_executed");
  assert.equal(eventBodies[1].event, "runtime_logs");
  assert.deepEqual(eventBodies[1].data.lines, ["line-2", "line-3"]);
});

test("command polling syncs OneClaw cron tasks through OpenClaw native cron RPC", async () => {
  const stateDir = makeWorkspace();
  const workspaceDir = path.join(stateDir, "workspace");
  const rpcCalls = [];
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === "cron.list") return { ok: true, payload: { jobs: [] } };
      if (method === "cron.add") return { ok: true, payload: { id: "native-cron-1" } };
      if (method === "cron.get") return { ok: true, payload: { id: "native-cron-1" } };
      if (method === "cron.run") return { ok: true, payload: { ok: true } };
      if (method === "cron.remove") return { ok: true, payload: { ok: true } };
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  let pollCount = 0;
  const restoreFetch = withFetch((url) => {
    assert.equal(url, "https://oneclaw.example.com/api/v1/agent/commands?instance_id=runtime-1&limit=10");
    pollCount += 1;
    if (pollCount === 1) {
      return jsonResponse({
        commands: [{
          id: "cmd-upsert-task",
          type: "upsert_cron_task",
          payload: {
            employee_id: "emp-1",
            task: {
              id: "oneclaw-task-1",
              name: "早间简报",
              schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
              session_target: "isolated",
              wake_mode: "now",
              payload: { kind: "agentTurn", message: "给我一份今天摘要" },
              delivery: { mode: "announce", channel: "last", best_effort: true },
              agent_id: "emp-1",
              enabled: true,
            },
          },
        }],
      });
    }
    return jsonResponse({
      commands: [
        { id: "cmd-run-task", type: "run_cron_task", payload: { task_id: "oneclaw-task-1" } },
        { id: "cmd-delete-task", type: "delete_cron_task", payload: { task_id: "oneclaw-task-1" } },
      ],
    });
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      stateDir,
      workspaceDir,
      gatewayRpc,
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  const addCall = rpcCalls.find((call) => call.method === "cron.add");
  assert.ok(addCall, "cron.add should be called");
  assert.equal(addCall.params.id, undefined);
  assert.equal(addCall.params.name, "oneclaw-task-1 · 早间简报");
  assert.equal(addCall.params.schedule.expr, "0 9 * * *");
  assert.equal(addCall.params.schedule.tz, "Asia/Shanghai");
  assert.equal(addCall.params.sessionTarget, "isolated");
  assert.equal(addCall.params.wakeMode, "now");
  assert.equal(addCall.params.agentId, "emp-1");
  assert.equal(addCall.params.delivery.bestEffort, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "oneclaw-cron-tasks.json"), "utf8")), {});
  assert.deepEqual(
    rpcCalls.filter((call) => call.method === "cron.run" || call.method === "cron.remove").map((call) => [call.method, call.params.id]),
    [["cron.run", "native-cron-1"], ["cron.remove", "native-cron-1"]],
  );
});

test("command polling applies regular channel config updates", async () => {
  const workspaceDir = makeWorkspace();
  const stateDir = makeWorkspace();
  let restartCalls = 0;
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({ channels: {}, plugins: { entries: {} } }, null, 2));
  const restoreFetch = withFetch((url) => {
    assert.equal(url, "https://oneclaw.example.com/api/v1/agent/commands?instance_id=runtime-1&limit=10");
    return jsonResponse({
      commands: [{
        id: "cmd-channel",
        type: "update_config",
        payload: {
          action: "update_channel",
          employee_id: "emp-1",
          openclaw_agent_id: "oneclaw-emp-1",
          account_id: "oneclaw-emp-1",
          channel: "telegram",
          state: {
            enabled: true,
            config: {
              access: { mode: "allowlist", allowFrom: ["tg-owner"], groupMode: "disabled" },
            },
            secrets: { botToken: "telegram-token" },
          },
        },
      }],
    });
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      stateDir,
      workspaceDir,
      restartGateway: async () => {
        restartCalls += 1;
        return { ok: true, pending: true };
      },
      gatewayRpc: { restart: () => {} },
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
  const account = cfg.channels.telegram.accounts["oneclaw-emp-1"];
  assert.equal(account.enabled, true);
  assert.equal(account.botToken, "telegram-token");
  assert.equal(account.dmPolicy, "allowlist");
  assert.deepEqual(account.allowFrom, ["tg-owner"]);
  assert.deepEqual(cfg.bindings, [{ agentId: "oneclaw-emp-1", match: { channel: "telegram", accountId: "oneclaw-emp-1" } }]);
  assert.equal(restartCalls, 1);
});

function writePairingSdkStub(source) {
  const dir = makeWorkspace();
  const file = path.join(dir, "conversation-runtime.js");
  fs.writeFileSync(file, source, "utf8");
  return file;
}

test("command polling approves channel access through pairing store without repair target", async () => {
  const workspaceDir = makeWorkspace();
  const stateDir = makeWorkspace();
  const sdkPath = writePairingSdkStub(`
    export async function approveChannelPairingCode(params) {
      globalThis.__pairingApprovals ||= [];
      globalThis.__pairingApprovals.push(params);
      return { id: "tg:42", entry: { code: params.code, id: "tg:42", createdAt: "2026-07-09T09:40:00Z" } };
    }
    export async function listChannelPairingRequests() { return []; }
  `);
  const previousSdkPath = process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE;
  process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE = sdkPath;
  globalThis.__pairingApprovals = [];
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/commands?instance_id=runtime-1&limit=10") {
      return jsonResponse({
        commands: [{
          id: "cmd-approve-access",
          type: "update_config",
          payload: {
            action: "approve_channel_access_request",
            employee_id: "emp-1",
            channel: "telegram",
            request_id: "PAIR-123",
            pairing_code: "PAIR-123",
          },
        }],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      stateDir,
      workspaceDir,
      repairTarget: "http://sidecar.local",
      clawArgs: () => ["/usr/local/lib/node_modules/openclaw/dist/entry.js"],
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
    if (previousSdkPath === undefined) delete process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE;
    else process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE = previousSdkPath;
  }

  assert.equal(globalThis.__pairingApprovals.length, 1);
  assert.equal(globalThis.__pairingApprovals[0].channel, "telegram");
  assert.equal(globalThis.__pairingApprovals[0].code, "PAIR-123");
});

test("command polling syncs pending channel access requests back to Go API", async () => {
  const workspaceDir = makeWorkspace();
  const stateDir = makeWorkspace();
  const sdkPath = writePairingSdkStub(`
    export async function listChannelPairingRequests(channel, env, accountId) {
      globalThis.__pairingLists ||= [];
      globalThis.__pairingLists.push({ channel, accountId });
      return [{ code: "LYMSQ59X", id: "8377439533", createdAt: "2026-07-09T09:41:00Z", meta: { username: "tester" } }];
    }
    export async function approveChannelPairingCode() { return null; }
  `);
  const previousSdkPath = process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE;
  process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE = sdkPath;
  globalThis.__pairingLists = [];
  const reports = [];
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/commands?instance_id=runtime-1&limit=10") {
      return jsonResponse({
        commands: [{
          id: "cmd-sync-access",
          type: "update_config",
          payload: {
            action: "sync_channel_access_requests",
            employee_id: "emp-1",
            channel: "telegram",
          },
        }],
      });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/access-requests") {
      reports.push(JSON.parse(opts.body));
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      stateDir,
      workspaceDir,
      clawArgs: () => ["/usr/local/lib/node_modules/openclaw/dist/entry.js"],
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.pollCommands();
  } finally {
    restoreFetch();
    if (previousSdkPath === undefined) delete process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE;
    else process.env.OPENCLAW_CONVERSATION_RUNTIME_MODULE = previousSdkPath;
  }

  assert.deepEqual(globalThis.__pairingLists, [{ channel: "telegram", accountId: undefined }]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].request_id, "LYMSQ59X");
  assert.equal(reports[0].subject_type, "pairing_code");
  assert.equal(reports[0].subject_id, "LYMSQ59X");
});

test("fetchPersonality reads Go API snake_case response and writes workspace files", async () => {
  const workspaceDir = makeWorkspace();
  const restoreFetch = withFetch((url, opts) => {
    assert.equal(url, "https://oneclaw.example.com/api/v1/agent/personality?instance_id=runtime-1");
    return jsonResponse({
      instance_id: "runtime-1",
      personality: {
        bot_name: "程序员助理",
        system_prompt: "Use Go API contract.",
      },
      template: {
        memory_files: [{ path: "memory/go.md", content: "snake_case" }],
        suggested_model: "anthropic/claude-sonnet-4",
      },
    });
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    const { personality, template } = await integration.fetchPersonality();
    assert.equal(personality.botName, "程序员助理");
    assert.equal(personality.systemPrompt, "Use Go API contract.");
    assert.equal(template.suggestedModel, "anthropic/claude-sonnet-4");
    await integration.applyPersonality(personality, template);
  } finally {
    restoreFetch();
  }

  assert.equal(fs.readFileSync(path.join(workspaceDir, "agents/main/SOUL.md"), "utf8"), "Use Go API contract.");
  assert.equal(fs.readFileSync(path.join(workspaceDir, "agents/main/memory/go.md"), "utf8"), "snake_case");
});

test("channel bind command stops polling after session expires", async () => {
  const workspaceDir = makeWorkspace();
  const startAt = Date.now();
  let heartbeatCalls = 0;
  let waitCalls = 0;
  let stateReports = 0;
  const restoreFetch = withFetch((url, opts) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      heartbeatCalls += 1;
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: heartbeatCalls === 1 ? [{
          id: "cmd-bind",
          type: "update_config",
          payload: {
            action: "bind_channel",
            employee_id: "emp-1",
            channel: "whatsapp",
            state: {
              binding: {
                session_id: "bind-1",
                expires_at: new Date(startAt + 45).toISOString(),
              },
            },
          },
        }] : [],
      });
    }
    if (url === "http://gateway.local/repair/whatsapp-login/start") {
      return jsonResponse({ ok: true, connected: false, qrDataUrl: "qr-start" });
    }
    if (url === "http://gateway.local/repair/whatsapp-login/wait") {
      waitCalls += 1;
      return jsonResponse({ ok: true, connected: false, qrDataUrl: `qr-wait-${waitCalls}` });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      stateReports += 1;
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 120));
  } finally {
    restoreFetch();
  }

  const stoppedWaitCalls = waitCalls;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(waitCalls, stoppedWaitCalls);
  assert.ok(stateReports >= 1, "should report at least one qr state");
});

test("channel bind command uses sidecar repair target", async () => {
  const workspaceDir = makeWorkspace();
  const startAt = Date.now();
  let repairCalls = 0;
  const restoreFetch = withFetch((url, opts) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: [{
          id: "cmd-bind",
          type: "update_config",
          payload: {
            action: "bind_channel",
            employee_id: "emp-1",
            channel: "whatsapp",
            state: {
              binding: {
                session_id: "bind-1",
                expires_at: new Date(startAt + 50).toISOString(),
              },
            },
          },
        }],
      });
    }
    if (url === "http://sidecar.local/repair/whatsapp-login/start") {
      assert.equal(opts.headers.Authorization, "Bearer secret-1");
      repairCalls += 1;
      return jsonResponse({ ok: true, connected: false, qrDataUrl: "qr-start" });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      return jsonResponse({ ok: true });
    }
    assert.notEqual(url, "http://gateway.local/repair/whatsapp-login/start");
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      repairTarget: "http://sidecar.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    restoreFetch();
  }

  assert.equal(repairCalls, 1);
});

test("wechat bind command enables openclaw-weixin config before starting login", async () => {
  const stateDir = makeWorkspace();
  const workspaceDir = path.join(stateDir, "workspace");
  fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify({
    plugins: { entries: {}, load: { paths: ["/opt/openclaw-plugins/node_modules/@tencent-weixin/openclaw-weixin"] } },
    channels: {},
  }));
  const startAt = Date.now();
  const bindingExpiresAt = new Date(startAt + 1_000).toISOString();
  const channelStates = [];
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: [{
          id: "cmd-bind-wechat",
          type: "update_config",
          payload: {
            action: "bind_channel",
            employee_id: "emp-1",
            channel: "wechat",
            state: {
              config: {
                access: {
                  mode: "allowlist",
                  allowFrom: ["wx-owner"],
                  groupMode: "disabled",
                  groupAllowFrom: [],
                  requireMention: true,
                },
              },
              binding: {
                session_id: "bind-1",
                expires_at: bindingExpiresAt,
              },
            },
          },
        }],
      });
    }
    if (url === "http://gateway.local/repair/wechat-login/start") {
      const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
      assert.equal(cfg.plugins.entries["openclaw-weixin"].enabled, true);
      assert.equal(cfg.channels["openclaw-weixin"].enabled, true);
      assert.equal(cfg.channels["openclaw-weixin"].dmPolicy, "allowlist");
      assert.deepEqual(cfg.channels["openclaw-weixin"].allowFrom, ["wx-owner"]);
      assert.deepEqual(JSON.parse(opts.body), {
        accountId: "emp-1",
        expiresAt: bindingExpiresAt,
      });
      return jsonResponse({
        ok: true,
        status: "scan",
        qrUrl: "https://wechat.example/qr",
        qrExpiresAt: "2026-07-09T11:20:00.000Z",
      });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      channelStates.push(JSON.parse(opts.body));
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      stateDir,
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    restoreFetch();
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
  assert.equal(cfg.plugins.entries["openclaw-weixin"].enabled, true);
  assert.equal(cfg.channels["openclaw-weixin"].enabled, true);
  assert.equal(cfg.channels["openclaw-weixin"].dmPolicy, "allowlist");
  assert.deepEqual(cfg.channels["openclaw-weixin"].allowFrom, ["wx-owner"]);
  assert.equal(channelStates[0]?.qr_expires_at, "2026-07-09T11:20:00.000Z");
});

test("wechat bind command binds the real plugin account id to the employee agent", async () => {
  const workspaceDir = makeWorkspace();
  const startAt = Date.now();
  const repairBodies = [];
  const restartCalls = [];
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: [{
          id: "cmd-bind-wechat-ready",
          type: "update_config",
          payload: {
            action: "bind_channel",
            employee_id: "emp-1",
            openclaw_agent_id: "agent-1",
            account_id: "agent-1",
            channel: "wechat",
            state: {
              binding: {
                session_id: "bind-1",
                expires_at: new Date(startAt + 1_000).toISOString(),
              },
            },
          },
        }],
      });
    }
    if (url === "http://gateway.local/repair/wechat-login/start") {
      return jsonResponse({
        ok: true,
        status: "connected",
        connected: true,
        connectedAccountId: "77597573942e-im-bot",
      });
    }
    if (url === "http://gateway.local/repair/bind-channel") {
      repairBodies.push(JSON.parse(opts.body));
      return jsonResponse({ ok: true });
    }
    if (url === "http://gateway.local/repair/restart") {
      restartCalls.push(true);
      return jsonResponse({ ok: true, pending: true });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    restoreFetch();
  }

  assert.deepEqual(repairBodies, [{
    channel: "openclaw-weixin",
    accountId: "77597573942e-im-bot",
    agentId: "agent-1",
  }]);
  assert.equal(restartCalls.length, 0);
});

test("refreshed WeChat QR is reported through the original binding session", async () => {
  const workspaceDir = makeWorkspace();
  const startAt = Date.now();
  const expiresAt = new Date(startAt + 2_000).toISOString();
  const oldQrUrl = "https://wechat.example/qr-old";
  const newQrUrl = "https://wechat.example/qr-new";
  const channelStates = [];
  let statusCalls = 0;
  let integration;
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: [{
          id: "cmd-bind-wechat-refresh",
          type: "update_config",
          payload: {
            action: "bind_channel",
            employee_id: "emp-1",
            openclaw_agent_id: "agent-1",
            channel: "wechat",
            state: { binding: { session_id: "bind-refresh", expires_at: expiresAt } },
          },
        }],
      });
    }
    if (url === "http://gateway-refresh.local/repair/wechat-login/start") {
      return jsonResponse({ ok: true, status: "scan", connected: false, qrUrl: oldQrUrl });
    }
    if (url === "http://gateway-refresh.local/repair/wechat-login") {
      statusCalls += 1;
      if (statusCalls === 1) {
        return jsonResponse({ ok: true, status: "scan", connected: false, qrUrl: newQrUrl });
      }
      return jsonResponse({
        ok: true,
        status: "connected",
        connected: true,
        connectedAccountId: "wechat-real-account",
      });
    }
    if (url === "http://gateway-refresh.local/repair/bind-channel") {
      return jsonResponse({ ok: true });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      channelStates.push(JSON.parse(opts.body));
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway-refresh.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    integration?.stop();
    restoreFetch();
  }

  const qrReports = channelStates.filter((state) => (
    state.session_id === "bind-refresh" && state.status === "pending" && state.qr_url
  ));
  assert.deepEqual(qrReports.map((state) => state.qr_url), [oldQrUrl, newQrUrl]);
  assert.deepEqual(qrReports.map((state) => state.session_id), ["bind-refresh", "bind-refresh"]);
  assert.equal(channelStates.some((state) => state.session_id === "bind-refresh" && state.status === "ready"), true);
});

test("cancel bind command stops active channel polling", async () => {
  const workspaceDir = makeWorkspace();
  const startAt = Date.now();
  let heartbeatCalls = 0;
  let waitCalls = 0;
  const restoreFetch = withFetch((url) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      heartbeatCalls += 1;
      const command = heartbeatCalls === 1
        ? {
            id: "cmd-bind",
            type: "update_config",
            payload: {
              action: "bind_channel",
              employee_id: "emp-1",
              channel: "whatsapp",
              state: {
                binding: {
                  session_id: "bind-1",
                  expires_at: new Date(startAt + 1_000).toISOString(),
                },
              },
            },
          }
        : {
            id: "cmd-cancel",
            type: "update_config",
            payload: {
              action: "cancel_bind_channel",
              employee_id: "emp-1",
              channel: "whatsapp",
              state: {
                binding: {
                  session_id: "bind-1",
                  expires_at: new Date(startAt + 1_000).toISOString(),
                },
              },
            },
          };
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: [command],
      });
    }
    if (url === "http://gateway.local/repair/whatsapp-login/start") {
      return jsonResponse({ ok: true, connected: false, qrDataUrl: "qr-start" });
    }
    if (url === "http://gateway.local/repair/whatsapp-login/wait") {
      waitCalls += 1;
      return jsonResponse({ ok: true, connected: false, qrDataUrl: `qr-wait-${waitCalls}` });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(waitCalls >= 1, "bind session should poll before cancel");
    await integration.sendHeartbeat();
    const stoppedWaitCalls = waitCalls;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(waitCalls, stoppedWaitCalls);
  } finally {
    restoreFetch();
  }
});

test("late WhatsApp wait result is ignored after binding cancellation", async () => {
  const workspaceDir = makeWorkspace();
  const startAt = Date.now();
  const channelStates = [];
  let heartbeatCalls = 0;
  let resolveLateWait;
  let markWaitStarted;
  const waitStarted = new Promise((resolve) => { markWaitStarted = resolve; });
  const lateWait = new Promise((resolve) => { resolveLateWait = resolve; });
  let integration;
  const restoreFetch = withFetch((url, opts = {}) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      heartbeatCalls += 1;
      const action = heartbeatCalls === 1 ? "bind_channel" : "cancel_bind_channel";
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: [{
          id: `cmd-${action}`,
          type: "update_config",
          payload: {
            action,
            employee_id: "emp-1",
            channel: "whatsapp",
            state: {
              binding: {
                session_id: "bind-late-wa",
                expires_at: new Date(startAt + 2_000).toISOString(),
              },
            },
          },
        }],
      });
    }
    if (url === "http://gateway.local/repair/whatsapp-login/start") {
      return jsonResponse({ ok: true, connected: false, qrDataUrl: "qr-start" });
    }
    if (url === "http://gateway.local/repair/whatsapp-login/wait") {
      markWaitStarted();
      return lateWait;
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      channelStates.push(JSON.parse(opts.body));
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await waitStarted;
    await integration.sendHeartbeat();
    resolveLateWait(jsonResponse({ ok: true, connected: false, qrDataUrl: "qr-too-late" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    integration?.stop();
    restoreFetch();
  }

  assert.equal(channelStates.some((state) => state.qr_url === "qr-too-late"), false);
  assert.equal(channelStates.some((state) => state.status === "expired"), true);
});

test("cancel wechat bind command stops wrapper login process", async () => {
  const workspaceDir = makeWorkspace();
  const startAt = Date.now();
  let heartbeatCalls = 0;
  let stopCalls = 0;
  const restoreFetch = withFetch((url) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      heartbeatCalls += 1;
      const command = heartbeatCalls === 1
        ? {
            id: "cmd-bind",
            type: "update_config",
            payload: {
              action: "bind_channel",
              employee_id: "emp-1",
              channel: "wechat",
              state: {
                binding: {
                  session_id: "bind-1",
                  expires_at: new Date(startAt + 1_000).toISOString(),
                },
              },
            },
          }
        : {
            id: "cmd-cancel",
            type: "update_config",
            payload: {
              action: "cancel_bind_channel",
              employee_id: "emp-1",
              channel: "wechat",
              state: {
                binding: {
                  session_id: "bind-1",
                  expires_at: new Date(startAt + 1_000).toISOString(),
                },
              },
            },
          };
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: [command],
      });
    }
    if (url === "http://gateway.local/repair/wechat-login/start") {
      return jsonResponse({ ok: true, status: "scan", qrUrl: "https://wechat.example/qr" });
    }
    if (url === "http://gateway.local/repair/wechat-login") {
      return jsonResponse({ ok: true, status: "scan", qrUrl: "https://wechat.example/qr2" });
    }
    if (url === "http://gateway.local/repair/wechat-login/stop") {
      stopCalls += 1;
      return jsonResponse({ ok: true, status: "idle" });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await integration.sendHeartbeat();
  } finally {
    restoreFetch();
  }

  assert.equal(stopCalls, 1);
});

test("wechat bind command reports plugin login failures instead of keeping stale QR pending", async () => {
  const workspaceDir = makeWorkspace();
  const startAt = Date.now();
  const channelStates = [];
  const restoreFetch = withFetch((url, opts) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date(startAt).toISOString(),
        commands: [{
          id: "cmd-bind-wechat-fail",
          type: "update_config",
          payload: {
            action: "bind_channel",
            employee_id: "emp-1",
            openclaw_agent_id: "agent-1",
            channel: "wechat",
            state: {
              binding: {
                session_id: "bind-fail",
                expires_at: new Date(startAt + 1_000).toISOString(),
              },
            },
          },
        }],
      });
    }
    if (url === "http://gateway.local/repair/wechat-login/start") {
      return jsonResponse({
        ok: true,
        status: "error",
        qrUrl: "https://liteapp.weixin.qq.com/q/stale?qrcode=old&bot_type=3",
        message: "temporary upstream network error",
      });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      channelStates.push(JSON.parse(opts.body));
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
      channelBindingPollMs: 10,
    });
    await integration.sendHeartbeat();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    restoreFetch();
  }

  assert.equal(
    channelStates.some((state) => state.status === "failed" && state.error === "temporary upstream network error"),
    true,
  );
});

test("unbind channel command removes runtime binding and restarts gateway", async () => {
  const workspaceDir = makeWorkspace();
  let unbindCalls = 0;
  let restartCalls = 0;
  const restoreFetch = withFetch((url, opts) => {
    if (url === "https://oneclaw.example.com/api/v1/agent/heartbeat") {
      return jsonResponse({
        instance_id: "runtime-1",
        status: "running",
        last_heartbeat: new Date().toISOString(),
        commands: [{
          id: "cmd-unbind",
          type: "update_config",
          payload: {
            action: "unbind_channel",
            employee_id: "emp-1",
            openclaw_agent_id: "agent-1",
            account_id: "agent-1",
            channel: "whatsapp",
            state: { status: "unbound", enabled: false },
          },
        }],
      });
    }
    if (url === "http://gateway.local/repair/unbind-channel") {
      unbindCalls += 1;
      const body = JSON.parse(opts.body);
      assert.equal(body.channel, "whatsapp");
      assert.equal(body.accountId, "agent-1");
      assert.equal(body.agentId, "agent-1");
      return jsonResponse({ ok: true, result: { removed: true } });
    }
    if (url === "http://gateway.local/repair/restart") {
      restartCalls += 1;
      return jsonResponse({ ok: true, pending: true });
    }
    if (url === "https://oneclaw.example.com/api/v1/agent/channels/state") {
      return jsonResponse({ ok: true });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  try {
    const integration = createOneclawIntegration({
      apiUrl: "https://oneclaw.example.com/api/v1",
      instanceId: "runtime-1",
      instanceSecret: "secret-1",
      workspaceDir,
      gatewayTarget: "http://gateway.local",
      gatewayToken: "gateway-token",
      isGatewayReady: () => true,
      isGatewayStarting: () => false,
    });
    await integration.sendHeartbeat();
  } finally {
    restoreFetch();
  }

  assert.equal(unbindCalls, 1);
  assert.equal(restartCalls, 1);
});
