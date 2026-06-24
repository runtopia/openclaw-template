// Gateway lifecycle management.

import childProcess from "node:child_process";
import fs from "node:fs";

export function createGatewayManager({ OPENCLAW_NODE, clawArgs, stateDir, workspaceDir, internalGatewayPort, internalGatewayHost, gatewayToken, isConfigured }) {
  const GATEWAY_TARGET = `http://${internalGatewayHost}:${internalGatewayPort}`;

  const LOG_BUFFER_MAX = 500;
  const logBuffer = [];
  function appendLog(line) {
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  }

  let gatewayProc = null;
  let gatewayStarting = null;
  let intentionalStop = false;   // true 表示本次退出是主动 stop/restart，exit handler 不自愈
  let consecutiveCrashes = 0;    // 连续意外崩溃次数：用于退避，到达上限后暂停自动重启
  let crashRestartTimer = null;  // pending 的自愈定时器句柄
  const MAX_CRASH_RESTARTS = 5;

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

  function ensureConfigToken() {
    const configPath = `${stateDir}/openclaw.json`;
    if (!fs.existsSync(configPath)) return;
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (!config.gateway) return;
      if (!config.gateway.auth) config.gateway.auth = {};
      if (config.gateway.auth.token === gatewayToken) return;
      config.gateway.auth.token = gatewayToken;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log("[gateway] patched config auth.token to match wrapper token");
    } catch (err) {
      console.warn(`[gateway] could not patch config auth.token: ${err.message}`);
    }
  }

  async function startGateway() {
    if (gatewayProc) return;
    if (!isConfigured()) throw new Error("Gateway cannot start: not configured");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    ensureConfigToken();

    const args = [
      "gateway", "run", "--bind", "loopback",
      "--port", String(internalGatewayPort),
      "--auth", "token", "--token", gatewayToken,
    ];
    gatewayProc = childProcess.spawn(OPENCLAW_NODE, clawArgs(args), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_WORKSPACE_DIR: workspaceDir },
    });
    intentionalStop = false; // 新进程已启动，清除上一轮可能残留的主动停止标记
    function handleOutput(chunk) {
      const lines = chunk.toString().split("\n");
      for (const line of lines) {
        if (line) { appendLog(line); process.stdout.write(line + "\n"); }
      }
    }
    gatewayProc.stdout.on("data", handleOutput);
    gatewayProc.stderr.on("data", handleOutput);
    const safeArgs = args.map((arg, i) => args[i - 1] === "--token" ? "[REDACTED]" : arg);
    console.log(`[gateway] starting: ${OPENCLAW_NODE} ${clawArgs(safeArgs).join(" ")}`);

    gatewayProc.on("error", (err) => { console.error(`[gateway] spawn error: ${String(err)}`); gatewayProc = null; });
    gatewayProc.on("exit", (code, signal) => {
      console.error(`[gateway] exited code=${code} signal=${signal}`);
      gatewayProc = null;
      const wasIntentional = intentionalStop;
      intentionalStop = false;
      if (wasIntentional || !isConfigured()) return; // 主动停止或未配置，不自愈
      consecutiveCrashes++;
      if (consecutiveCrashes > MAX_CRASH_RESTARTS) {
        console.error(`[gateway] crashed ${consecutiveCrashes}x; auto-restart paused until next request`);
        return;
      }
      const delay = Math.min(1000 * 2 ** (consecutiveCrashes - 1), 30_000);
      console.log(`[gateway] unexpected exit — auto-restarting in ${delay}ms (crash #${consecutiveCrashes})`);
      crashRestartTimer = setTimeout(() => {
        crashRestartTimer = null;
        ensureGatewayRunning().catch((err) => console.error(`[gateway] auto-restart failed: ${err.message}`));
      }, delay);
    });
  }

  async function ensureGatewayRunning() {
    if (!isConfigured()) return { ok: false, reason: "not configured" };
    if (gatewayProc) return { ok: true };
    if (!gatewayStarting) {
      gatewayStarting = (async () => {
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 60_000 });
        if (!ready) throw new Error("Gateway did not become ready in time");
        consecutiveCrashes = 0; // 成功就绪，重置崩溃计数
      })().finally(() => { gatewayStarting = null; });
    }
    await gatewayStarting;
    return { ok: true };
  }

  async function restartGateway({ waitReady = true } = {}) {
    if (crashRestartTimer) { clearTimeout(crashRestartTimer); crashRestartTimer = null; }
    if (gatewayProc) {
      const proc = gatewayProc;
      intentionalStop = true; // 主动重启：exit handler 跳过自愈，由本函数负责拉起
      gatewayProc = null; // 先清引用，防止 exit handler 重复触发
      await new Promise((resolve) => {
        // SIGKILL 兜底：5s 后若仍未退出则强杀
        const forceKill = setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch {}
          resolve();
        }, 5000);
        proc.once("exit", () => {
          clearTimeout(forceKill);
          resolve();
        });
        try { proc.kill("SIGTERM"); } catch { clearTimeout(forceKill); resolve(); }
      });
    }
    if (!waitReady) {
      // 触发后台启动但不等待就绪。修复助手必须立即拿回控制权——否则当
      // gateway 起不来时（正是用户求助修复助手的场景），这里会阻塞最长
      // 60s 再抛错，把聊天卡死并以错误中断。调用方随后用 isGatewayReady /
      // getRecentLogs（即 AI 的 get_status / read_logs 工具）观察新进程。
      ensureGatewayRunning().catch((err) =>
        console.error(`[gateway] background restart did not become ready: ${err.message}`));
      return { ok: true, pending: true };
    }
    return ensureGatewayRunning();
  }

  function stopGateway() {
    intentionalStop = true; // 主动停止，禁止自愈
    if (crashRestartTimer) { clearTimeout(crashRestartTimer); crashRestartTimer = null; }
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
    getRecentLogs: (n = 100) => logBuffer.slice(-Math.min(n, LOG_BUFFER_MAX)),
  };
}