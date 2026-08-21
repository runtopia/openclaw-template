import assert from "node:assert/strict";
import test from "node:test";

import {
  ONECLAW_USER_AGENT_FALLBACK,
  buildOneClawUserAgent,
  resolveOneClawUserAgent,
  sanitizeOneClawUserAgent,
  withOneClawUserAgent,
} from "../src/integration/user-agent.js";

test("OneClaw outbound User-Agent uses the Runtime image version", () => {
  assert.equal(buildOneClawUserAgent("3.0.1"), "OneClaw-Cloud/3.0.1");
  assert.equal(resolveOneClawUserAgent(undefined, "test-f3f7834"), "OneClaw-Cloud/test-f3f7834");
});

test("OneClaw outbound User-Agent preserves a valid global override", () => {
  assert.equal(resolveOneClawUserAgent("  ExampleCloud/7.2  ", "3.0.1"), "ExampleCloud/7.2");
  assert.deepEqual(withOneClawUserAgent(
    { Authorization: "Bearer secret" },
    { IMAGE_VERSION: "3.0.1" },
  ), {
    Authorization: "Bearer secret",
    "User-Agent": "OneClaw-Cloud/3.0.1",
  });
});

test("explicit Provider User-Agent wins case-insensitively", () => {
  assert.deepEqual(withOneClawUserAgent(
    { "user-agent": "CustomProvider/4" },
    { ONECLAW_USER_AGENT: "OneClaw-Cloud/3.0.1", IMAGE_VERSION: "3.0.1" },
  ), { "user-agent": "CustomProvider/4" });
});

test("invalid User-Agent values cannot inject headers", () => {
  assert.equal(sanitizeOneClawUserAgent("OneClaw-Cloud/1.0\r\nX-Test: injected"), undefined);
  assert.equal(resolveOneClawUserAgent("bad\nvalue", "3.0.1"), "OneClaw-Cloud/3.0.1");
  assert.equal(buildOneClawUserAgent("bad version"), ONECLAW_USER_AGENT_FALLBACK);
});
