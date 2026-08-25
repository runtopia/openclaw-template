import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("startup preloads personality before Gateway and defers pollers until reconciliation", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src", "index.js"), "utf8");
  const loadCachedProfile = source.indexOf("oneclaw.loadCachedRuntimeProfile()");
  const fetchProfile = source.indexOf("oneclaw.fetchPersonality({ timeoutMs: 750 })");
  const preloadProfile = source.indexOf("oneclaw.prepareEmployeesForStartup(runtimeProfile.employees)");
  const startGateway = source.indexOf("gateway.ensureGatewayRunning()");
  const reconcileProfile = source.indexOf("oneclaw.reconcileAllEmployees(runtimeProfile.employees)");
  const startPollers = source.indexOf("oneclaw.start();", reconcileProfile);

  assert.ok(loadCachedProfile >= 0);
  assert.ok(loadCachedProfile < fetchProfile);
  assert.ok(fetchProfile < preloadProfile);
  assert.ok(preloadProfile < startGateway);
  assert.ok(startGateway < reconcileProfile);
  assert.ok(reconcileProfile < startPollers);
  assert.doesNotMatch(source, /openclaw setup|running openclaw setup/);
  assert.ok(source.includes('OPENCLAW_GATEWAY_STARTUP_TRACE: process.env.OPENCLAW_GATEWAY_STARTUP_TRACE || "1"'));
  assert.ok(source.includes("ONECLAW_FAST_GATEWAY_ENTRY"));
});

test("container liveness reports promptly while Gateway warms up", () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("HEALTHCHECK --interval=5s --timeout=2s --start-period=2s"));
  assert.ok(dockerfile.includes("curl -fsS http://localhost:${PORT}/health >/dev/null"));
  assert.ok(dockerfile.includes("RUN node /app/scripts/openclaw-gateway-fast.mjs --check"));
  assert.ok(dockerfile.includes("ENV ONECLAW_FAST_GATEWAY_ENTRY=/app/scripts/openclaw-gateway-fast.mjs"));
});
