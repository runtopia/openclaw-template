import crypto from "node:crypto";

// Wrapper owns input transport; the Gateway plugin owns AI admission. Never
// release AI until writable transport has exited. All transitions serialize.
export function createBrowserHandoff({ rpc, desktop, now = Date.now, heartbeatMs = 45000, idleMs = 1800000 }) {
  let owner = null, lastSeen = 0, client = null, stopped = false, chain = Promise.resolve();
  let ticking = null;
  const liveStarts = new Set();
  const pendingEnds = new Map();
  let sawConnection = false;
  let browserHealth = { browserReady: false, browserStatusAvailable: false }, healthAt = -Infinity;
  let lastViewedAt = now(), lastIdleCheck = -Infinity;
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
      lastViewedAt = now();
      if (matches(token)) lastSeen = now();
      const state = await inspect();
      if (now() - healthAt >= 5000) {
        healthAt = now();
        try {
          const frame = await rpc.rpcGateway('browser.request', { method: 'GET', path: '/', query: { profile: 'openclaw' } }, 3000);
          browserHealth = { browserStatusAvailable: frame.ok === true, browserReady: frame.ok === true && frame.payload?.running === true && frame.payload?.cdpReady === true };
        } catch { browserHealth = { browserReady: false, browserStatusAvailable: false }; }
      }
      return { ...state, ...browserHealth, mine: matches(token) };
    });
  }
  function request(_token, fields = {}) {
    return serial(async () => {
      if (stopped || !desktop.status().ready) throw new Error("Desktop is not ready");
      if (owner) throw new Error("Another page has reserved browser control");
      const candidate = crypto.randomBytes(32).toString("hex");
      await command("request", candidate, fields);
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
  function resume(token, fields = {}) {
    return serial(async () => {
      requireOwner(token);
      await revoke();
      await command("resume", owner, fields);
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
  function focusTask(fields, operation = 'focus') {
    return serial(async () => {
      await command(operation === 'close' ? 'validate-close' : 'validate-focus', null, fields);
      let frame;
      try {
        frame = await rpc.rpcGateway('browser.request', {
          method: operation === 'close' ? 'DELETE' : 'POST', path: operation === 'close' ? '/tabs/' + encodeURIComponent(fields.targetId) : '/tabs/focus', query: { profile: 'openclaw' }, body: { targetId: fields.targetId }, timeoutMs: 5000,
        }, 6000);
      } catch (error) {
        error.browserOperationUncertain = true;
        throw error;
      }
      if (!frame.ok) {
        const error = new Error('Task tab focus failed');
        error.browserOperationUncertain = frame.error?.code === 'disconnected' || /timeout|timed out/i.test(frame.error?.message || '');
        throw error;
      }
      return { ok: true };
    });
  }
  async function suspendIdleBrowser() {
    const selected = await serial(async () => {
      if (stopped || owner || !rpc.isGatewayConnected() || idleMs <= 0
          || now() - lastViewedAt < idleMs || now() - lastIdleCheck < 30000) return null;
      lastIdleCheck = now();
      const { tasks = [] } = await command('idle-tasks');
      return { task: tasks[0] };
    });
    if (!selected) return;
    // Close one eligible task at a time after revalidating its ownership.
    // The plugin calls internal/close back into focusTask(), which also uses
    // serial(). Never hold that queue while waiting for its callback. The
    // plugin's execution lease still guards admission during each native close.
    if (selected.task) {
      const task = selected.task;
      const frame = await rpc.rpcGateway('browseruse.control', { action: 'close-task', sessionKey: task.sessionKey, browserTaskId: task.browserTaskId }, 60000);
      if (!frame.ok) throw new Error(frame.error?.message || 'Idle task closure failed');
    }
    return serial(async () => {
      // Viewing or takeover can occur while close-task runs outside this queue.
      // Recheck before stopping the shared browser, then let idle-begin validate
      // the latest task revision and execution leases atomically in the plugin.
      if (stopped || owner || !rpc.isGatewayConnected() || now() - lastViewedAt < idleMs) return;
      const { candidate } = await command('idle-candidate');
      if (!candidate || !Array.isArray(candidate.targetIds)) return;
      const tabs = await rpc.rpcGateway('browser.request', { method: 'GET', path: '/tabs', query: { profile: 'openclaw' } }, 5000);
      if (!tabs.ok || tabs.payload?.running !== true || !Array.isArray(tabs.payload?.tabs)) return;
      // Never close manually created or unrecognized pages. A fresh browser's
      // default empty page has no task data; all meaningful pages must be owned.
      if (tabs.payload.tabs.some(tab => tab.type === 'page' && !candidate.targetIds.includes(tab.targetId)
          && !['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/'].includes(tab.url))) return;
      const callId = crypto.randomUUID();
      await command('idle-begin', null, { callId, revision: candidate.revision });
      let uncertain = false, stoppedBrowser = false;
      try {
        const frame = await rpc.rpcGateway('browser.request', { method: 'POST', path: '/stop', query: { profile: 'openclaw' }, timeoutMs: 5000 }, 6000);
        uncertain = !frame.ok && (frame.error?.code === 'disconnected' || /timeout|timed out/i.test(frame.error?.message || ''));
        stoppedBrowser = frame.ok === true;
      } catch { uncertain = true; }
      await command(uncertain ? 'idle-uncertain' : 'idle-end', null, { callId, stopped: stoppedBrowser });
      if (stoppedBrowser) { browserHealth = { browserReady: false, browserStatusAvailable: true }; healthAt = now(); }
    });
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
  async function tickOnce() {
    try {
      const idle = await serial(async () => {
        if (stopped) return false;
        const connected = rpc.isGatewayConnected();
        await settleStarts(connected && !sawConnection);
        sawConnection = connected;
        if (!owner) return connected;
        if (now() - lastSeen > heartbeatMs || !rpc.isGatewayConnected()) {
          await pause();
          return false;
        }
        await inspect();
        return false;
      });
      if (idle) await suspendIdleBrowser();
    } catch {
      await serial(async () => {
        sawConnection = false;
        // Losing the control plane never leaves an interactive connection.
        await revoke().catch(() => {});
      });
    }
  }
  function tick() {
    // Timer ticks share the whole maintenance operation, including the part
    // outside serial(), so no second sweep can reclaim the same task.
    if (!ticking) ticking = tickOnce().finally(() => { ticking = null; });
    return ticking;
  }
  const timer = setInterval(tick, 1000);
  timer.unref();
  function close() { stopped = true; clearInterval(timer); return serial(pause).catch(() => {}); }
  return { status, request, release, resume, recover, runNative, focusTask, connect, close, tick };
}
