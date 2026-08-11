import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createGatewayManager,
  DEFAULT_GATEWAY_START_TIMEOUT_MS,
} from "../src/gateway/manager.js";

class FakeProc extends EventEmitter {
  constructor(id) {
    super();
    this.id = id;
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
    this.startedAt = Date.now();
  }

  kill(signal = "SIGTERM") {
    if (this.killed) return true;
    this.killed = true;
    setTimeout(() => this.emit("exit", null, signal), 5);
    return true;
  }
}

test("gateway startup allows first-boot plugin preparation to finish", () => {
  assert.equal(DEFAULT_GATEWAY_START_TIMEOUT_MS, 180_000);
});

test("gateway manager uses the dedicated launch arguments without changing other CLI calls", async (t) => {
  const originalSpawn = childProcess.spawn;
  const originalFetch = globalThis.fetch;
  let spawnedArgs;
  childProcess.spawn = (_command, args) => {
    spawnedArgs = args;
    return new FakeProc(1);
  };
  globalThis.fetch = async () => new Response("ok", { status: 200 });
  t.after(() => {
    childProcess.spawn = originalSpawn;
    globalThis.fetch = originalFetch;
  });

  const gateway = createGatewayManager({
    OPENCLAW_NODE: "node",
    clawArgs: (args) => ["entry.js", ...args],
    gatewayArgs: (args) => ["fast.mjs", ...args],
    stateDir: "/tmp/openclaw-template-gateway-fast-test",
    workspaceDir: "/tmp/openclaw-template-gateway-fast-test/workspace",
    internalGatewayPort: 18789,
    internalGatewayHost: "127.0.0.1",
    gatewayToken: "test-token",
    isConfigured: () => true,
  });
  t.after(() => gateway.stopGateway());

  await gateway.ensureGatewayRunning();
  assert.deepEqual(spawnedArgs.slice(0, 3), ["fast.mjs", "gateway", "run"]);
  assert.equal(spawnedArgs.includes("entry.js"), false);
});

test("gateway restart requests are coalesced while a restart is already in flight", async (t) => {
  const originalSpawn = childProcess.spawn;
  const originalFetch = globalThis.fetch;
  const procs = [];
  const testStart = Date.now();

  childProcess.spawn = () => {
    const proc = new FakeProc(procs.length + 1);
    procs.push(proc);
    return proc;
  };
  globalThis.fetch = async () => {
    const live = procs.find((proc) => !proc.killed && Date.now() - proc.startedAt >= 20);
    if (live || Date.now() - testStart >= 150) return new Response("ok", { status: 200 });
    const err = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    throw err;
  };

  t.after(() => {
    childProcess.spawn = originalSpawn;
    globalThis.fetch = originalFetch;
  });

  const gateway = createGatewayManager({
    OPENCLAW_NODE: "node",
    clawArgs: (args) => args,
    stateDir: "/tmp/openclaw-template-gateway-test",
    workspaceDir: "/tmp/openclaw-template-gateway-test/workspace",
    internalGatewayPort: 18789,
    internalGatewayHost: "127.0.0.1",
    gatewayToken: "test-token",
    isConfigured: () => true,
    gatewayStartTimeoutMs: 5_000,
  });
  t.after(() => gateway.stopGateway());

  await gateway.ensureGatewayRunning();
  assert.equal(gateway.isGatewayReady(), true);

  await Promise.all([
    gateway.restartGateway({ waitReady: false }),
    gateway.restartGateway({ waitReady: false }),
    gateway.restartGateway({ waitReady: false }),
  ]);

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(gateway.isGatewayReady(), true);
  assert.equal(procs.filter((proc) => !proc.killed).length, 1);
});

test("gateway runner exit does not crash-loop when gateway http is still reachable", async (t) => {
  const originalSpawn = childProcess.spawn;
  const originalFetch = globalThis.fetch;
  const procs = [];

  childProcess.spawn = () => {
    const proc = new FakeProc(procs.length + 1);
    procs.push(proc);
    setTimeout(() => proc.emit("exit", 0, null), 10);
    return proc;
  };
  globalThis.fetch = async () => new Response("ok", { status: 200 });

  t.after(() => {
    childProcess.spawn = originalSpawn;
    globalThis.fetch = originalFetch;
  });

  const gateway = createGatewayManager({
    OPENCLAW_NODE: "node",
    clawArgs: (args) => args,
    stateDir: "/tmp/openclaw-template-gateway-test-existing",
    workspaceDir: "/tmp/openclaw-template-gateway-test-existing/workspace",
    internalGatewayPort: 18789,
    internalGatewayHost: "127.0.0.1",
    gatewayToken: "test-token",
    isConfigured: () => true,
    gatewayStartTimeoutMs: 5_000,
  });
  t.after(() => gateway.stopGateway());

  await gateway.ensureGatewayRunning();
  assert.equal(gateway.isGatewayReady(), true);

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(procs.length, 1);
  assert.equal(gateway.isGatewayReady(), true);
});

test("gateway graceful exit waits for in-process restart before spawning replacement", async (t) => {
  const originalSpawn = childProcess.spawn;
  const originalFetch = globalThis.fetch;
  const procs = [];
  const testStart = Date.now();

  childProcess.spawn = () => {
    const proc = new FakeProc(procs.length + 1);
    procs.push(proc);
    if (proc.id === 1) setTimeout(() => {
      proc.killed = true;
      proc.emit("exit", 0, null);
    }, 10);
    return proc;
  };
  globalThis.fetch = async () => {
    if (Date.now() - testStart >= 80) return new Response("ok", { status: 200 });
    const err = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    throw err;
  };

  t.after(() => {
    childProcess.spawn = originalSpawn;
    globalThis.fetch = originalFetch;
  });

  const gateway = createGatewayManager({
    OPENCLAW_NODE: "node",
    clawArgs: (args) => args,
    stateDir: "/tmp/openclaw-template-gateway-test-in-process-restart",
    workspaceDir: "/tmp/openclaw-template-gateway-test-in-process-restart/workspace",
    internalGatewayPort: 18789,
    internalGatewayHost: "127.0.0.1",
    gatewayToken: "test-token",
    isConfigured: () => true,
    gatewayStartTimeoutMs: 5_000,
    gracefulRestartAdoptionMs: 700,
  });
  t.after(() => gateway.stopGateway());

  await gateway.ensureGatewayRunning();
  await new Promise((resolve) => setTimeout(resolve, 850));

  assert.equal(procs.length, 1);
  assert.equal(gateway.isGatewayReady(), true);
});

test("gateway graceful service restart recovers without crash backoff", async (t) => {
  const originalSpawn = childProcess.spawn;
  const originalFetch = globalThis.fetch;
  const procs = [];

  childProcess.spawn = () => {
    const proc = new FakeProc(procs.length + 1);
    procs.push(proc);
    if (proc.id === 1) setTimeout(() => {
      proc.killed = true;
      proc.emit("exit", 0, null);
    }, 10);
    return proc;
  };
  globalThis.fetch = async () => {
    const live = procs.find((proc) => !proc.killed && Date.now() - proc.startedAt >= 20);
    if (live) return new Response("ok", { status: 200 });
    const err = new Error("connect ECONNREFUSED");
    err.code = "ECONNREFUSED";
    throw err;
  };

  t.after(() => {
    childProcess.spawn = originalSpawn;
    globalThis.fetch = originalFetch;
  });

  const gateway = createGatewayManager({
    OPENCLAW_NODE: "node",
    clawArgs: (args) => args,
    stateDir: "/tmp/openclaw-template-gateway-test-graceful-restart",
    workspaceDir: "/tmp/openclaw-template-gateway-test-graceful-restart/workspace",
    internalGatewayPort: 18789,
    internalGatewayHost: "127.0.0.1",
    gatewayToken: "test-token",
    isConfigured: () => true,
    gatewayStartTimeoutMs: 5_000,
    gracefulRestartAdoptionMs: 300,
  });
  t.after(() => gateway.stopGateway());

  const started = gateway.ensureGatewayRunning();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await started;
  assert.equal(procs.length, 2);
  assert.equal(gateway.isGatewayReady(), true);
});
