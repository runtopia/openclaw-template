import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOnboardArgs,
  resolveAuth,
  applyRuntimeDefaults,
  generateConfigDirect,
  patchClawroutersProviderBaseUrl,
  resolveClawroutersApiBaseUrl,
} from "../src/config/generate.js";
import { readEnvProviderKey } from "../src/repair/ai-key.js";

test("CLAWROUTERS_BASE_URL origin is normalized to /api/v1", () => {
  const env = { CLAWROUTERS_BASE_URL: "https://clawrouters-dev.example.com" };
  assert.equal(resolveClawroutersApiBaseUrl(env), "https://clawrouters-dev.example.com/api/v1");
});

test("CLAWROUTERS_BASE_URL accepts a value that already includes /api/v1", () => {
  const env = { CLAWROUTERS_BASE_URL: "https://clawrouters-dev.example.com/api/v1/" };
  assert.equal(resolveClawroutersApiBaseUrl(env), "https://clawrouters-dev.example.com/api/v1");
});

test("auto-config uses CLAWROUTERS_BASE_URL for onboard fallback args", () => {
  const auth = resolveAuth({
    CLAWROUTERS_API_KEY: "cr_test",
    CLAWROUTERS_BASE_URL: "https://clawrouters-dev.example.com",
  });
  const args = buildOnboardArgs({
    ...auth,
    workspaceDir: "/tmp/workspace",
    internalGatewayPort: 18789,
    gatewayToken: "gateway-test",
  });

  assert.equal(auth.customBaseUrl, "https://clawrouters-dev.example.com/api/v1");
  assert.ok(args.includes("--custom-base-url"));
  assert.equal(args[args.indexOf("--custom-base-url") + 1], "https://clawrouters-dev.example.com/api/v1");
});

test("direct config and repair key use CLAWROUTERS_BASE_URL", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-"));
  const configPath = path.join(tmp, "openclaw.json");
  const env = {
    CLAWROUTERS_API_KEY: "cr_test",
    CLAWROUTERS_BASE_URL: "https://clawrouters-dev.example.com",
  };

  generateConfigDirect({
    configPath,
    workspaceDir: path.join(tmp, "workspace"),
    gatewayToken: "gateway-test",
    env,
  });

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(
    cfg.models.providers.clawrouters.baseUrl,
    "https://clawrouters-dev.example.com/api/v1",
  );
  assert.equal(
    readEnvProviderKey(env).baseUrl,
    "https://clawrouters-dev.example.com/api/v1",
  );
  assert.deepEqual(cfg.agents.defaults.heartbeat, { every: "2h", target: "last" });
  assert.deepEqual(cfg.agents.defaults.memorySearch, {
    enabled: true,
    sources: ["memory", "sessions"],
    provider: "clawrouters",
    model: "auto",
    remote: {
      baseUrl: "https://clawrouters-dev.example.com/api/v1",
      apiKey: { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" },
    },
  });
});

test("direct config binds environment token channels to main account", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-config-"));
  const configPath = path.join(tmp, "openclaw.json");
  const cfg = generateConfigDirect({
    configPath, workspaceDir: path.join(tmp, "workspace", "agents", "main"), gatewayToken: "gateway-test",
    env: { CLAWROUTERS_API_KEY: "cr_test", TELEGRAM_BOT_TOKEN: "telegram-token", SLACK_BOT_TOKEN: "xoxb", SLACK_APP_TOKEN: "xapp" },
  });
  assert.equal(cfg.channels.telegram.accounts.main.botToken, "telegram-token");
  assert.equal(cfg.channels.slack.accounts.main.botToken, "xoxb");
  assert.equal(cfg.bindings.filter((binding) => binding.agentId === "main").length, 2);
});

test("existing openclaw.json runtime defaults are patched from CLAWROUTERS_BASE_URL", () => {
  const cfg = {
    models: {
      mode: "merge",
      providers: {
        clawrouters: {
          baseUrl: "https://www.clawrouters.com/api/v1",
          apiKey: { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" },
        },
      },
    },
    agents: { defaults: {} },
  };

  const patched = applyRuntimeDefaults(cfg, {
    CLAWROUTERS_API_KEY: "cr_test",
    CLAWROUTERS_BASE_URL: "https://clawrouters-dev.example.com",
  });

  assert.equal(patched, true);
  assert.equal(
    cfg.models.providers.clawrouters.baseUrl,
    "https://clawrouters-dev.example.com/api/v1",
  );
  assert.deepEqual(cfg.agents.defaults.heartbeat, { every: "2h", target: "last" });
  assert.deepEqual(cfg.agents.defaults.memorySearch, {
    enabled: true,
    sources: ["memory", "sessions"],
    provider: "clawrouters",
    model: "auto",
    remote: {
      baseUrl: "https://clawrouters-dev.example.com/api/v1",
      apiKey: { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" },
    },
  });
});

test("legacy ClawRouters base URL patcher updates memory search remote base URL", () => {
  const cfg = {
    models: {
      providers: {
        clawrouters: {
          baseUrl: "https://www.clawrouters.com/api/v1",
          apiKey: { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" },
        },
      },
    },
    agents: {
      defaults: {
        memorySearch: {
          enabled: true,
          sources: ["memory", "sessions"],
          provider: "clawrouters",
          model: "auto",
          remote: {
            baseUrl: "https://www.clawrouters.com/api/v1",
            apiKey: { source: "env", provider: "default", id: "CLAWROUTERS_API_KEY" },
          },
        },
      },
    },
  };

  const patched = patchClawroutersProviderBaseUrl(cfg, {
    CLAWROUTERS_BASE_URL: "https://clawrouters-dev.example.com",
  });

  assert.equal(patched, true);
  assert.equal(
    cfg.agents.defaults.memorySearch.remote.baseUrl,
    "https://clawrouters-dev.example.com/api/v1",
  );
});
