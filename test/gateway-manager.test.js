import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createGatewayManager } from "../src/lib/gateway.js";

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
  });
  t.after(() => gateway.stopGateway());

  await gateway.ensureGatewayRunning();
  assert.equal(gateway.isGatewayReady(), true);

  await new Promise((resolve) => setTimeout(resolve, 1_200));
  assert.equal(procs.length, 1);
  assert.equal(gateway.isGatewayReady(), true);
});
