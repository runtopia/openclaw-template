import assert from "node:assert/strict";
import test from "node:test";

import { applyRuntimeDefaults } from "../src/config/generate.js";

const CLAWROUTERS_KEY_REF = {
  source: "env",
  provider: "default",
  id: "CLAWROUTERS_API_KEY",
};

test("ClawRouters credentials provision dormant managed TTS and realtime Talk", () => {
  const cfg = {};
  const env = {
    CLAWROUTERS_API_KEY: "cr_test",
    CLAWROUTERS_BASE_URL: "https://clawrouters.test/",
  };

  assert.equal(applyRuntimeDefaults(cfg, env), true);
  assert.deepEqual(cfg.messages.tts, {
    provider: "openai",
    providers: {
      openai: {
        apiKey: CLAWROUTERS_KEY_REF,
        baseUrl: "https://clawrouters.test/api/v1",
        model: "tts",
        speakerVoice: "coral",
      },
    },
  });
  assert.deepEqual(cfg.talk, {
    realtime: {
      provider: "openai",
      model: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      consultRouting: "provider-direct",
      providers: {
        openai: {
          managedBy: "oneclaw-clawrouters",
          apiKey: CLAWROUTERS_KEY_REF,
          baseUrl: "https://clawrouters.test/api/v1",
          model: "realtime",
          speakerVoice: "coral",
          vadThreshold: 0.5,
          silenceDurationMs: 700,
          prefixPaddingMs: 300,
        },
      },
    },
    consultThinkingLevel: "off",
    consultFastMode: true,
  });

  assert.equal(applyRuntimeDefaults(cfg, env), false, "voice convergence must be idempotent");
});

test("managed voice convergence refreshes the base URL and preserves supported preferences", () => {
  const cfg = {
    messages: {
      tts: {
        provider: "openai",
        providers: {
          openai: {
            apiKey: CLAWROUTERS_KEY_REF,
            baseUrl: "https://old.example/api/v1",
            model: "tts",
            speakerVoice: "cedar",
          },
        },
      },
    },
    talk: {
      realtime: {
        provider: "openai",
        providers: {
          openai: {
            managedBy: "oneclaw-clawrouters",
            apiKey: CLAWROUTERS_KEY_REF,
            baseUrl: "https://old.example/api/v1",
            model: "realtime",
            speakerVoice: "cedar",
            vadThreshold: 0.35,
            silenceDurationMs: 900,
            prefixPaddingMs: 250,
          },
        },
      },
    },
  };

  applyRuntimeDefaults(cfg, {
    CLAWROUTERS_API_KEY: "cr_test",
    CLAWROUTERS_BASE_URL: "https://new.example/api/v1",
  });

  assert.equal(cfg.messages.tts.providers.openai.baseUrl, "https://new.example/api/v1");
  assert.equal(cfg.messages.tts.providers.openai.speakerVoice, "cedar");
  assert.equal(cfg.talk.realtime.providers.openai.baseUrl, "https://new.example/api/v1");
  assert.equal(cfg.talk.realtime.providers.openai.speakerVoice, "cedar");
  assert.equal(cfg.talk.realtime.providers.openai.vadThreshold, 0.35);
  assert.equal(cfg.talk.realtime.providers.openai.silenceDurationMs, 900);
  assert.equal(cfg.talk.realtime.providers.openai.prefixPaddingMs, 250);
});

test("managed voice defaults never replace user-owned TTS or realtime providers", () => {
  const cfg = {
    messages: {
      tts: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: { apiKey: "user-secret", voiceId: "voice-a" },
        },
      },
    },
    talk: {
      instructions: "Keep this user instruction",
      realtime: {
        provider: "google",
        model: "gemini-live",
        transport: "provider-websocket",
        providers: {
          google: { apiKey: "user-secret", speakerVoice: "Aoede" },
        },
      },
    },
  };
  const expectedMessages = structuredClone(cfg.messages);
  const expectedTalk = structuredClone(cfg.talk);

  applyRuntimeDefaults(cfg, { CLAWROUTERS_API_KEY: "cr_test" });

  assert.deepEqual(cfg.messages, expectedMessages);
  assert.deepEqual(cfg.talk, expectedTalk);
});

test("an unselected personal OpenAI voice configuration remains user-owned", () => {
  const cfg = {
    messages: {
      tts: {
        providers: { openai: { apiKey: "sk-user", speakerVoice: "alloy" } },
      },
    },
    talk: {
      realtime: {
        providers: { openai: { apiKey: "sk-user", speakerVoice: "alloy" } },
      },
    },
  };
  const expectedMessages = structuredClone(cfg.messages);
  const expectedTalk = structuredClone(cfg.talk);

  applyRuntimeDefaults(cfg, { CLAWROUTERS_API_KEY: "cr_test" });

  assert.deepEqual(cfg.messages, expectedMessages);
  assert.deepEqual(cfg.talk, expectedTalk);
});

test("an explicit OpenAI TTS selection may use an auth profile and remains user-owned", () => {
  const cfg = {
    messages: { tts: { provider: "openai", auto: "never" } },
  };

  applyRuntimeDefaults(cfg, { CLAWROUTERS_API_KEY: "cr_test" });

  assert.deepEqual(cfg.messages, { tts: { provider: "openai", auto: "never" } });
});

test("removing the child key cleans only OneClaw-managed voice references", () => {
  const cfg = {
    messages: {
      locale: "zh",
      tts: {
        provider: "openai",
        auto: "never",
        providers: {
          openai: {
            apiKey: CLAWROUTERS_KEY_REF,
            baseUrl: "https://clawrouters.test/api/v1",
            model: "tts",
            speakerVoice: "coral",
          },
          elevenlabs: { apiKey: "user-secret" },
        },
      },
    },
    talk: {
      instructions: "Keep this user instruction",
      consultThinkingLevel: "off",
      consultFastMode: true,
      realtime: {
        provider: "openai",
        model: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        consultRouting: "provider-direct",
        providers: {
          openai: {
            managedBy: "oneclaw-clawrouters",
            apiKey: CLAWROUTERS_KEY_REF,
            baseUrl: "https://clawrouters.test/api/v1",
            model: "realtime",
          },
          google: { apiKey: "user-secret", model: "gemini-live" },
        },
      },
    },
  };

  applyRuntimeDefaults(cfg, {});

  assert.deepEqual(cfg.messages, {
    locale: "zh",
    tts: {
      auto: "never",
      providers: { elevenlabs: { apiKey: "user-secret" } },
    },
  });
  assert.deepEqual(cfg.talk, {
    instructions: "Keep this user instruction",
    realtime: {
      providers: { google: { apiKey: "user-secret", model: "gemini-live" } },
    },
  });
});

test("legacy managed realtime settings migrate to the native OpenAI relay", () => {
  const cfg = {
    talk: {
      realtime: {
        provider: "oneclaw-cr-voice",
        providers: {
          "oneclaw-cr-voice": {
            speakerVoice: "unsupported-legacy-voice",
            rmsThreshold: 0.2,
          },
        },
      },
    },
  };

  applyRuntimeDefaults(cfg, { CLAWROUTERS_API_KEY: "cr_test" });

  assert.equal(cfg.talk.realtime.provider, "openai");
  assert.equal(cfg.talk.realtime.providers["oneclaw-cr-voice"], undefined);
  assert.equal(cfg.talk.realtime.providers.openai.managedBy, "oneclaw-clawrouters");
  assert.equal(cfg.talk.realtime.providers.openai.speakerVoice, "coral");
  assert.equal(cfg.talk.realtime.providers.openai.rmsThreshold, undefined);
});
