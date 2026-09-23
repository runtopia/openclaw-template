import crypto from "node:crypto";

// Wrapper owns input transport; the Gateway plugin owns AI admission. Never
// release AI until writable transport has exited. All transitions serialize.
export function createBrowserHandoff({ rpc, desktop, now = Date.now, heartbeatMs = 45000 }) {
  let owner = null, lastSeen = 0, client = null, stopped = false, chain = Promise.resolve();
  const liveStarts = new Set();
  const pendingEnds = new Map();
  let sawConnection = false;
  const serial = (fn) => {
    const result = chain.then(fn);
    chain = result.catch(() => {});
    return result;
  };
  const command = async (action, token = owner, fields = {}) => {
    const frame = await rpc.rpcGateway("browseruse.control", { action, token, ...fields }, 5000);
    if (!frame.ok) throw new Error(frame.error?.message || "Browser Use plugin is unavailable");
    return frame.payload;
  };
  async function settleStarts(discover = false) {
    if (!rpc.isGatewayConnected()) return;
    if (discover) {
      const result = await command("admin-starts");
      for (const item of result.starts || []) {
        if (typeof item.callId === "string" && !liveStarts.has(item.callId) && !pendingEnds.has(item.callId)) pendingEnds.set(item.callId, true);
      }
    }
    if (!pendingEnds.size) return;
    let startupComplete;
    for (const [callId, uncertain] of pendingEnds) {
      if (liveStarts.has(callId)) continue;
      if (uncertain) {
        if (startupComplete === undefined) {
          const frame = await rpc.rpcGateway("browser.request", { method: "GET", path: "/", query: { profile: "openclaw" } }, 5000);
          const state = frame.payload;
          startupComplete = frame.ok && state?.profile === "openclaw" && state.running === true && state.cdpReady === true && Number.isInteger(state.pid) && state.pid > 0;
        }
        if (!startupComplete) continue;
      }
      await command("admin-end", null, { callId });
      pendingEnds.delete(callId);
    }
  }
  const matches = (token) => typeof token === "string" && Boolean(owner) && token === owner;
  function requireOwner(token) { if (!matches(token)) throw new Error("This page does not own browser control"); }
  async function revoke() {
    const old = client; client = null;
    old?.terminate();
    await desktop.stopControl();
  }
  async function pause() {
    await revoke();
    if (owner) await command("pause");
  }
  async function inspect() {
    await settleStarts();
    const state = await command("status");
    if (owner && state.mode === "waiting" && state.inFlight === 0) {
      await command("grant");
      try { await desktop.startControl(); }
      catch (err) { await command("pause"); throw err; }
      return command("status");
    }
    if (owner && state.mode === "human" && !desktop.controlReady()) {
      await pause();
      return command("status");
    }
    if (state.mode !== "human" && desktop.controlReady()) await revoke();
    return state;
  }
  function status(token) {
    return serial(async () => {
      if (matches(token)) lastSeen = now();
      return { ...await inspect(), mine: matches(token) };
    });
  }
  function request() {
    return serial(async () => {
      if (stopped || !desktop.status().ready) throw new Error("Desktop is not ready");
      if (owner) throw new Error("Another page has reserved browser control");
      const candidate = crypto.randomBytes(32).toString("hex");
      await command("request", candidate);
      owner = candidate; lastSeen = now();
      try { return { ...await inspect(), token: owner, mine: true }; }
      catch (err) { await pause().catch(() => {}); throw err; }
    });
  }
  function release(token) {
    return serial(async () => {
      requireOwner(token);
      await revoke();
      const state = await command("release");
      owner = null;
      return state;
    });
  }
  function resume(token) {
    return serial(async () => {
      requireOwner(token);
      await revoke();
      await command("resume");
      try { await desktop.startControl(); }
      catch (err) { await command("pause"); throw err; }
      lastSeen = now();
      return { ...await command("status"), mine: true };
    });
  }
  async function runNative(fn) {
    const callId = crypto.randomUUID();
    liveStarts.add(callId);
    let uncertain = false;
    try {
      await serial(() => command("admin-begin", null, { callId }));
      return await fn();
    } catch (error) {
      uncertain = error.browserOperationUncertain === true;
      throw error;
    } finally {
      liveStarts.delete(callId);
      // Retain the acknowledgement across disconnections. An ambiguous start
      // is only settled after the managed browser reports a ready owned PID.
      pendingEnds.set(callId, uncertain);
      await serial(() => settleStarts()).catch(() => {});
    }
  }
  function recover() {
    return serial(async () => {
      const state = await command("status");
      if (state.mode !== "paused") throw new Error("Only a paused browser can be recovered");
      await revoke();
      const result = await command("recover");
      owner = null;
      return result;
    });
  }
  // Accept at most one writable connection. Auth/origin checks live in routes.
  function connect(token, accept) {
    return serial(async () => {
      requireOwner(token);
      const state = await inspect();
      if (state.mode !== "human" || client) throw new Error("Browser input is unavailable or already connected");
      client = accept();
      const accepted = client;
      lastSeen = now();
      accepted.once("close", () => {
        if (client === accepted) serial(async () => { if (client === accepted) await pause(); }).catch(() => {});
      });
      accepted.on("message", () => { if (client === accepted) lastSeen = now(); });
    });
  }
  async function tick() {
    return serial(async () => {
      if (stopped) return;
      const connected = rpc.isGatewayConnected();
      try {
        await settleStarts(connected && !sawConnection);
        sawConnection = connected;
        if (!owner) return;
        if (now() - lastSeen > heartbeatMs || !rpc.isGatewayConnected()) {
          await pause();
          return;
        }
        await inspect();
      } catch {
        sawConnection = false;
        // Losing the control plane never leaves an interactive connection.
        await revoke().catch(() => {});
      }
    });
  }
  const timer = setInterval(tick, 1000);
  timer.unref();
  function close() { stopped = true; clearInterval(timer); return serial(pause).catch(() => {}); }
  return { status, request, release, resume, recover, runNative, connect, close, tick };
}
