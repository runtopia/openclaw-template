// Runs an isolated, headed Chromium on a private X display. No production profile or credentials.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { createTaskBroker } from "../src/browser/task-broker.js";
import { createTaskPreview } from "../src/browser/preview.js";
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
  const work = createBrowserWork(),
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
  const broker = createTaskBroker({ rpc }),
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
  await input({ type: "text", text: "中文 A 😀" });
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
    }),
  );
} finally {
  chrome?.kill("SIGTERM");
  xvfb.kill("SIGTERM");
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}
