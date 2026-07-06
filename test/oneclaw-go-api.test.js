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

test("fetchPersonality reads Go API snake_case response and writes workspace files", async () => {
  const workspaceDir = makeWorkspace();
  const restoreFetch = withFetch((url) => {
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
