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

  assert.equal(fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf8"), "You are a Go-backed assistant.");
  assert.equal(fs.readFileSync(path.join(workspaceDir, "memory/profile.md"), "utf8"), "hello");
});

test("employee template command syncs an OpenClaw agent workspace", async () => {
  const workspaceDir = makeWorkspace();
  const rpcCalls = [];
  const gatewayRpc = {
    waitUntilConnected: async () => {},
    rpcGateway: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === "agents.create") {
        return { ok: true, payload: { agentId: "oneclaw-emp-1" } };
      }
      if (method === "agents.files.set") {
        return { ok: true, payload: { ok: true } };
      }
      throw new Error(`unexpected rpc ${method}`);
    },
  };
  const restoreFetch = withFetch((url) => {
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
    await integration.sendHeartbeat();
  } finally {
    restoreFetch();
  }

  assert.equal(fs.existsSync(path.join(workspaceDir, "SOUL.md")), false);
  assert.equal(rpcCalls[0].method, "agents.create");
  assert.equal(rpcCalls[0].params.name, "oneclaw-emp-1");
  assert.equal(rpcCalls[1].method, "agents.files.set");
  assert.deepEqual(
    rpcCalls.filter((call) => call.method === "agents.files.set").map((call) => call.params.name),
    ["SOUL.md", "memory/dev.md"],
  );
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

  assert.equal(fs.readFileSync(path.join(workspaceDir, "SOUL.md"), "utf8"), "Use Go API contract.");
  assert.equal(fs.readFileSync(path.join(workspaceDir, "memory/go.md"), "utf8"), "snake_case");
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
