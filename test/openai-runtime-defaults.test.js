import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyRuntimeDefaults,
  generateConfigDirect,
} from "../src/config/generate.js";

test("fresh OpenAI config stays on the embedded agent runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oneclaw-openai-runtime-"));
  const cfg = generateConfigDirect({
    configPath: path.join(root, "openclaw.json"),
    workspaceDir: path.join(root, "workspace"),
    gatewayToken: "gateway-token",
    env: { OPENAI_API_KEY: "test-key" },
  });

  assert.deepEqual(cfg.models.providers.openai.agentRuntime, { id: "pi" });
});

test("persisted OpenAI providers receive the Desktop runtime pin", () => {
  const cfg = {
    models: {
      providers: {
        openai: { api: "openai-completions" },
        "openai-codex": { api: "openai-codex-responses" },
        custom: { api: "openai-completions" },
      },
    },
  };

  applyRuntimeDefaults(cfg, {});

  assert.deepEqual(cfg.models.providers.openai.agentRuntime, { id: "pi" });
  assert.deepEqual(cfg.models.providers["openai-codex"].agentRuntime, { id: "pi" });
  assert.equal(cfg.models.providers.custom.agentRuntime, undefined);
});

test("runtime defaults preserve an explicit OpenAI harness selection", () => {
  const cfg = {
    models: {
      providers: {
        openai: {
          api: "openai-completions",
          agentRuntime: { id: "codex" },
        },
      },
    },
  };

  applyRuntimeDefaults(cfg, {});

  assert.deepEqual(cfg.models.providers.openai.agentRuntime, { id: "codex" });
});
