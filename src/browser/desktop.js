import { spawn, execFile } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

// A Railway volume belongs to one Runtime. A redeploy changes the container
// hostname, while Chromium's singleton symlinks still point to its old /tmp.
// Clean only dead managed-profile links, before Gateway can launch Chromium.
export function cleanupStaleBrowserLocks(stateDir) {
  const dir = path.join(stateDir, "browser", "openclaw", "user-data");
  try {
    const lock = fs.readlinkSync(path.join(dir, "SingletonLock"));
    if (!fs.lstatSync(path.join(dir, "SingletonSocket")).isSymbolicLink()) return false;
    if (fs.existsSync(path.join(dir, "SingletonSocket"))) return false;
    const match = /^(.*)-(\d+)$/.exec(lock);
    if (!match) return false;
    if (match[1] === os.hostname()) {
      try { process.kill(Number(match[2]), 0); return false; }
      catch (err) { if (err.code !== "ESRCH") return false; }
    }
    for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
      const file = path.join(dir, name);
      try { if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); }
      catch (err) { if (err.code !== "ENOENT") throw err; }
    }
    return true;
  } catch { return false; }
}

export function tcpReady(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(300);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

// Own only display/preview processes. OpenClaw owns Chromium and its profile.
export function createBrowserDesktop({ env = process.env, log = console.log } = {}) {
  const enabled = env.ONECLAW_BROWSER_ENABLED === "1";
  const display = ":99";
  const children = new Set();
  let stopped = false, ready = false, pending, retryTimer, failures = 0, error = null;
  let controlChild = null;
  if (enabled) env.DISPLAY = display;
  function killChildren() {
    for (const child of children) {
      child.kill("SIGTERM");
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 1500);
      timer.unref();
    }
    children.clear();
  }
  function failed(message) {
    if (stopped || error) return;
    ready = false;
    error = message;
    log(`[browser-desktop] ${message}`);
    controlChild?.kill("SIGTERM");
    killChildren();
    if (++failures <= 5) {
      retryTimer = setTimeout(() => { pending = null; start().catch(() => {}); }, Math.min(1000 * 2 ** failures, 30000));
      retryTimer.unref();
    }
  }
  function launch(command, args) {
    if (stopped || error) throw new Error("desktop stopped");
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    children.add(child);
    // Drain stderr without retaining potentially sensitive desktop content.
    child.stderr.on("data", () => {});
    child.on("error", (err) => failed(`${command}: ${err.message}`));
    child.on("exit", (code, signal) => {
      if (!children.delete(child)) return;
      failed(`${command} exited (${code ?? signal})`);
    });
  }
  async function waitFor(probe) {
    const until = Date.now() + 8000;
    while (!stopped && !error && Date.now() < until) {
      if (await probe()) return;
      await delay(100);
    }
    throw new Error(error || "desktop readiness timed out");
  }
  function start() {
    if (!enabled || stopped) return Promise.resolve();
    if (pending) return pending;
    error = null;
    pending = (async () => {
      if (cleanupStaleBrowserLocks(env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"))) {
        log("[browser-desktop] removed stale Chromium singleton links from previous container");
      }
      launch("Xvfb", [display, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-noreset"]);
      await waitFor(() => new Promise((resolve) => {
        execFile("xdpyinfo", ["-display", display], { env, timeout: 500 }, (err) => resolve(!err));
      }));
      launch("openbox", ["--sm-disable"]);
      // Enforce view-only on the server, not just in the noVNC UI.
      launch("x11vnc", ["-display", display, "-localhost", "-rfbport", "5900", "-forever", "-shared", "-viewonly", "-nopw", "-noxdamage"]);
      await waitFor(() => tcpReady(5900));
      launch("/usr/bin/websockify", ["127.0.0.1:6080", "127.0.0.1:5900"]);
      await waitFor(() => tcpReady(6080));
      ready = true;
      log("[browser-desktop] ready (read-only, 1440x900)");
    })().catch((err) => { failed(err.message); throw err; });
    return pending;
  }
  async function startControl() {
    if (!ready || stopped) throw new Error("Desktop is not ready");
    if (controlChild) throw new Error("Writable desktop is already running");
    if (await tcpReady(5901)) throw new Error("Control port is occupied");
    const child = spawn("x11vnc", ["-display", display, "-localhost", "-rfbport", "5901", "-forever", "-shared", "-nopw", "-noxdamage", "-clear_all"], { env, stdio: "ignore" });
    controlChild = child;
    let launchError;
    child.on("error", (err) => { launchError = err; if (controlChild === child) controlChild = null; });
    child.on("exit", () => { if (controlChild === child) controlChild = null; });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && controlChild === child && !launchError) {
      if (await tcpReady(5901)) return;
      await delay(100);
    }
    await stopControl();
    throw new Error(launchError?.message || "Writable desktop failed to start");
  }
  async function stopControl() {
    const child = controlChild;
    if (!child) return;
    await new Promise((resolve, reject) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 1500);
      const timer = setTimeout(() => { clearTimeout(force); reject(new Error("Writable desktop did not exit; AI remains paused")); }, 5000);
      const cleanup = () => { clearTimeout(force); clearTimeout(timer); };
      child.once("exit", () => { cleanup(); resolve(); });
      child.once("error", (err) => { cleanup(); reject(err); });
      child.kill("SIGTERM");
    });
  }
  function stop() {
    stopped = true;
    ready = false;
    clearTimeout(retryTimer);
    controlChild?.kill("SIGTERM");
    killChildren();
  }
  return { start, stop, startControl, stopControl, controlReady: () => Boolean(controlChild), status: () => ({ enabled, ready, error, viewOnly: true }) };
}
