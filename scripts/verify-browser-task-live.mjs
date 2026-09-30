// Runs an isolated, headed Chromium on a private X display. No production profile or credentials.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createTaskBroker } from "../src/browser/task-broker.js";
import { createTaskPreview } from "../src/browser/preview.js";
import { createBrowserHandoff } from "../src/browser/handoff.js";
const source = process.env.BROWSER_USE_SOURCE_DIR;
if (!source)
  throw new Error(
    "Set BROWSER_USE_SOURCE_DIR to the browser-use source directory",
  );
const { createBrowserWork } = await import(path.join(source, "work.mjs"));
const { createControl } = await import(path.join(source, "control.mjs"));
const { createTaskControl } = await import(
  path.join(source, "task-control.mjs")
);
const { registerBrowserUse } = await import(path.join(source, "index.mjs"));
const dir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-task-live-"));
const display = process.env.BROWSER_TEST_DISPLAY || ":107",
  port = Number(process.env.BROWSER_TEST_PORT || 18813);
const xvfb = spawn(
  "/usr/bin/Xvfb",
  [display, "-screen", "0", "1280x800x24", "-nolisten", "tcp"],
  { stdio: "ignore" },
);
let chrome;
async function cdp(url, method, params = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("CDP timeout"));
    }, 8000);
    ws.on("error", reject);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method, params })));
    ws.on("message", (data) => {
      const value = JSON.parse(String(data));
      if (value.id === 1) {
        clearTimeout(timer);
        ws.close();
        value.error
          ? reject(new Error(value.error.message))
          : resolve(value.result);
      }
    });
  });
}
try {
  chrome = spawn(
    "/usr/bin/chromium",
    [
      `--user-data-dir=${dir}/profile`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "about:blank",
    ],
    {
      env: { ...process.env, DISPLAY: display },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let diagnostics = "";
  chrome.stderr.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-2000);
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready)
    throw new Error("Isolated Chromium did not start: " + diagnostics);
  const create = async (html) =>
    (
      await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent("data:text/html," + html)}`,
        { method: "PUT" },
      )
    ).json();
  const a = await create(
    `<title>Task A</title><input id="value" style="position:fixed;left:0;top:0;width:400px;height:100px"><button id="popup" style="position:fixed;left:450px;top:0;width:100px;height:100px" onclick="window.open('about:blank','child')">Popup</button><div style="height:2500px">A</div>`,
  );
  const b = await create("<title>Task B</title><h1>B original</h1>");
  let time = Date.now();
  const work = createBrowserWork({ now: () => time }),
    control = createControl({ file: path.join(dir, "control.json") }),
    authority = createTaskControl({ work, control });
  const bind = (session, target) => {
    work.complete(
      {
        toolName: "browser",
        toolCallId: session + "-open",
        params: { action: "open" },
        result: { details: { targetId: target.id } },
      },
      { sessionKey: session, runId: session },
    );
    work.finish({ success: true }, { sessionKey: session, runId: session });
    return work.status(session);
  };
  const taskA = bind("a", a),
    taskB = bind("b", b);
  const rpc = {
    rpcGateway: async (method, params) => {
      if (method === "browser.request")
        return {
          ok: true,
          payload: {
            running: true,
            cdpReady: true,
            cdpUrl: `http://127.0.0.1:${port}`,
          },
        };
      try {
        return {
          ok: true,
          payload: authority.command(
            params,
            work.status(params.sessionKey, {
              browserTaskId: params.browserTaskId,
            }),
          ),
        };
      } catch {
        return { ok: false };
      }
    },
  };
  let dropEndAcknowledgement = false;
  const broker = createTaskBroker({ rpc: { rpcGateway: async (method, params) => {
    const result = await rpc.rpcGateway(method, params);
    if (dropEndAcknowledgement && params.action === "input-end") {
      dropEndAcknowledgement = false;
      throw new Error("Test: completion acknowledgement lost");
    }
    return result;
  } } }),
    base = {
      sessionKey: "a",
      browserTaskId: taskA.browserTaskId,
      expectedTargetId: taskA.targetId,
      generation: taskA.generation,
    };
  const grant = await broker({ ...base, action: "request" }),
    token = grant.token;
  // The other task really navigates and takes the foreground while A is human controlled.
  authority.check(
    { toolName: "browser", params: { action: "navigate", targetId: b.id } },
    { sessionKey: "b" },
  );
  await cdp(b.webSocketDebuggerUrl, "Page.navigate", {
    url: "data:text/html,<title>Task B finished</title><h1>B navigated independently</h1>",
  });
  await cdp(b.webSocketDebuggerUrl, "Page.bringToFront");
  const input = (event) => broker({ ...base, token, action: "input", event });
  await input({ type: "down", x: 0.08, y: 0.04 });
  await input({ type: "up", x: 0.08, y: 0.04 });
  dropEndAcknowledgement = true;
  await assert.rejects(input({ type: "text", text: "中文 A 😀" }));
  assert.equal((await broker({ ...base, token, action: "status" })).inFlight, 0);
  const value = await cdp(a.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: 'document.getElementById("value").value',
    returnByValue: true,
  });
  assert.equal(value.result.value, "中文 A 😀");
  const title = await cdp(b.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: "document.title",
    returnByValue: true,
  });
  assert.equal(title.result.value, "Task B finished");
  const position = await cdp(a.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: "JSON.stringify({x:500/innerWidth,y:50/innerHeight})",
    returnByValue: true,
  });
  const point = JSON.parse(position.result.value);
  await input({ type: "down", ...point });
  await input({ type: "up", ...point });
  assert.equal(
    work.status("a").pages.length,
    2,
    "manual popup must stay in the originating task",
  );
  await assert.rejects(
    input({ type: "text", text: "stale frame" }),
    "old page frame cannot type into new popup",
  );
  await broker({ ...base, token, action: "select", targetId: a.id });
  await assert.rejects(
    broker({ ...base, token, action: "select", targetId: b.id }),
  );
  const capture = createTaskPreview({ rpc });
  assert.match((await capture(a.id)).image, /^data:image\/jpeg;base64,/);
  assert.equal(
    (await broker({ ...base, token, action: "status" })).mode,
    "human",
  );
  await assert.rejects(
    broker({
      ...base,
      token: "wrong",
      action: "input",
      event: { type: "text", text: "BAD" },
    }),
  );
  await broker({ ...base, token, action: "release" });
  assert.equal((await broker({ ...base, action: "status" })).mode, "ai");
  // Real plugin -> Wrapper callback -> Chromium closure, with an injected
  // clock only for idle eligibility. No production profile or instance used.
  work.setRetained("a", { browserTaskId: taskA.browserTaskId }, false);
  control.work = work;
  control.taskControl = authority;
  const handlers = new Map();
  let handoff, running = true;
  const lifecycleRpc = { isGatewayConnected: () => true, rpcGateway: async (method, params) => {
    if (handlers.has(method)) {
      let result;
      await handlers.get(method)({ params, respond: (ok, payload, error) => { result = { ok, payload, error }; } });
      return result;
    }
    if (params.method === "DELETE") {
      const response = await fetch(`http://127.0.0.1:${port}/json/close/${params.body.targetId}`);
      return { ok: response.ok };
    }
    if (params.path === "/tabs") {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return { ok: true, payload: { running, tabs: tabs.map(t => ({ targetId: t.id, type: t.type, url: t.url })) } };
    }
    if (params.path === "/stop") {
      await new Promise(resolve => { chrome.once("exit", resolve); chrome.kill("SIGTERM"); });
      running = false;
      return { ok: true };
    }
    return { ok: true, payload: { profile: "openclaw", running, cdpReady: running, pid: running ? chrome.pid : null } };
  } };
  registerBrowserUse({ on() {}, registerGatewayMethod(name, handler) { handlers.set(name, handler); } }, control, {
    idleMs: 1000, preview: async target => (await capture(target)).image,
    close: (event, context) => handoff.focusTask({ runId: event.runId, toolCallId: event.toolCallId,
      sessionKey: context.sessionKey, targetId: event.params.targetId }, "close"),
  });
  handoff = createBrowserHandoff({ rpc: lifecycleRpc, desktop: { controlReady: () => false, stopControl: async () => {} }, now: () => time, idleMs: 1000 });
  try {
    for (const delay of [2000, 31000, 31000]) { time += delay; await handoff.tick(); }
    assert.equal(control.status().mode, "ai");
    assert.equal(control.status().inFlight, 0);
    assert.equal(running, false, JSON.stringify({ lifecycle: work.lifecycle(1000), tasks: [work.status("a"), work.status("b")], control: control.status() }));
    for (const session of ["a", "b"]) {
      assert.equal(work.status(session).resourceState, "expired");
      assert.match(work.frame(session, { browserTaskId: work.status(session).browserTaskId }).image, /^data:image\/jpeg;base64,/);
    }
  } finally { await handoff.close(); }
  console.log(
    JSON.stringify({
      passed: true,
      headed: true,
      isolatedProfile: true,
      backgroundTaskAInput: value.result.value,
      taskBTitle: title.result.value,
      taskAStayedHuman: true,
      screenshot: true,
      wrongTokenRejected: true,
      handback: true,
      popupOwnership: true,
      staleFrameRejected: true,
      tabSelection: true,
      lostInputAcknowledgementReconciled: true,
      inputNotReplayed: true,
      idleReclamation: true,
      finalSnapshotsPreserved: true,
    }),
  );
} finally {
  chrome?.kill("SIGTERM");
  xvfb.kill("SIGTERM");
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
