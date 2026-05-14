// Gateway lifecycle management.

import childProcess from "node:child_process";
import fs from "node:fs";

export function createGatewayManager({ OPENCLAW_NODE, clawArgs, stateDir, workspaceDir, internalGatewayPort, internalGatewayHost, gatewayToken, isConfigured }) {
  const GATEWAY_TARGET = `http://${internalGatewayHost}:${internalGatewayPort}`;
  let gatewayProc = null;
  let gatewayStarting = null;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitForGatewayReady(opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const start = Date.now();
    const endpoints = ["/openclaw", "/", "/health"];
    while (Date.now() - start < timeoutMs) {
      for (const endpoint of endpoints) {
        try {
          const res = await fetch(`${GATEWAY_TARGET}${endpoint}`, { method: "GET" });
          if (res) { console.log(`[gateway] ready at ${endpoint}`); return true; }
        } catch (err) {
          if (err.code !== "ECONNREFUSED" && err.cause?.code !== "ECONNREFUSED") {
            const msg = err.code || err.message;
            if (msg !== "fetch failed" && msg !== "UND_ERR_CONNECT_TIMEOUT") {
              console.warn(`[gateway] health check error: ${msg}`);
            }
          }
        }
      }
      await sleep(250);
    }
    console.error(`[gateway] failed to become ready after ${timeoutMs / 1000}s`);
    return false;
  }

  async function startGateway() {
    if (gatewayProc) return;
    if (!isConfigured()) throw new Error("Gateway cannot start: not configured");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const args = [
      "gateway", "run", "--bind", "loopback",
      "--port", String(internalGatewayPort),
      "--auth", "token", "--token", gatewayToken,
    ];
    gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
      stdio: "inherit",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WORKSPACE_DIR: workspaceDir },
    });
    const safeArgs = args.map((arg, i) => args[i - 1] === "--token" ? "[REDACTED]" : arg);
    console.log(`[gateway] starting: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`);

    gatewayProc.on("error", (err) => { console.error(`[gateway] spawn error: ${String(err)}`); gatewayProc = null; });
    gatewayProc.on("exit", (code, signal) => { console.error(`[gateway] exited code=${code} signal=${signal}`); gatewayProc = null; });
  }

  async function ensureGatewayRunning() {
    if (!isConfigured()) return { ok: false, reason: "not configured" };
    if (gatewayProc) return { ok: true };
    if (!gatewayStarting) {
      gatewayStarting = (async () => {
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
        if (!ready) throw new Error("Gateway did not become ready in time");
      })().finally(() => { gatewayStarting = null; });
    }
    await gatewayStarting;
    return { ok: true };
  }

  async function restartGateway() {
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch (err) { console.warn(`[gateway] kill error: ${err.message}`); }
      await sleep(750);
      gatewayProc = null;
    }
    return ensureGatewayRunning();
  }

  function stopGateway() {
    if (gatewayProc) { try { gatewayProc.kill("SIGTERM"); } catch {} gatewayProc = null; }
  }

  return {
    GATEWAY_TARGET,
    startGateway,
    ensureGatewayRunning,
    restartGateway,
    stopGateway,
    isGatewayStarting: () => gatewayStarting !== null,
    isGatewayReady: () => gatewayProc !== null && gatewayStarting === null,
    getGatewayProc: () => gatewayProc,
  };
}