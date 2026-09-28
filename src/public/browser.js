import RFB from "/browser/novnc/core/rfb.js";
const status = document.querySelector("#status");
const start = document.querySelector("#start");
let rfb;
let controller = sessionStorage.getItem("browser-use-controller");
let controlState = null;
let connectionMode = "view";
let busy = false;
let statusRequestId = 0;
let reconnectTimer, retries = 0;
let allowHumanConnection = false;
const takeover = document.querySelector("#takeover");
const release = document.querySelector("#release");
const recover = document.querySelector("#recover");
const controlStatus = document.querySelector("#control-status");
const controlHeaders = () => controller ? { "X-Browser-Controller": controller } : {};

async function connect(mode = "view") {
  clearTimeout(reconnectTimer);
  connectionMode = mode;
  const previous = rfb; rfb = null; previous?.disconnect();
  status.textContent = "正在连接画面…";
  try {
    const response = await fetch("/browser/status");
    if (!response.ok || response.redirected) throw new Error("暂时无法打开画面，请重新登录后再试");
    const state = await response.json();
    start.disabled = !state.ready || (controlState?.available && controlState.mode !== "ai");
    if (!state.ready) throw new Error("画面还没准备好，请稍后重新连接");
    const url = new URL(mode === "human" ? "/browser/control/ws" : "/browser/ws", location.href);
    if (mode === "human") url.searchParams.set("controller", controller);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new RFB(document.querySelector("#screen"), url.href);
    rfb = client;
    client.viewOnly = mode !== "human";
    client.scaleViewport = true;
    client.addEventListener("connect", () => { if (rfb === client) { retries = 0; status.textContent = mode === "human" ? "已连接 · 现在由你操作" : "已连接 · 你正在观看"; } });
    client.addEventListener("disconnect", () => { if (rfb === client) { status.textContent = mode === 'human' ? '操作连接断开，请明确继续操作或交还' : '画面断开，正在恢复…'; retryView(); } });
    client.addEventListener("securityfailure", () => { if (rfb === client) status.textContent = "无法验证访问权限，请重新登录"; });
  } catch (err) { status.textContent = err.message; retryView(); }
}
function retryView() {
  if (connectionMode === 'human' || document.hidden || retries >= 5) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect('view'), Math.min(1000 * 2 ** retries++, 15000));
}
start.addEventListener("click", async () => {
  start.disabled = true;
  status.textContent = "正在打开浏览器…";
  try {
    const response = await fetch("/browser/start", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "暂时没能打开浏览器");
    status.textContent = "浏览器已打开 · 你正在观看";
  } catch { status.textContent = "暂时没能打开浏览器，请稍后重试"; }
  finally { start.disabled = false; }
});
document.querySelector("#reconnect").addEventListener("click", () => { retries = 0; connect('view'); });
document.querySelector('#zoom').addEventListener('click', (event) => {
  if (!rfb) return;
  rfb.scaleViewport = !rfb.scaleViewport;
  event.target.textContent = rfb.scaleViewport ? '放大画面' : '适合屏幕';
});
async function refreshControl() {
  const requestId = ++statusRequestId;
  try {
    const response = await fetch("/browser/control/status", { headers: controlHeaders() });
    if (!response.ok) throw new Error("暂时无法切换操作人");
    const nextState = await response.json();
    if (requestId !== statusRequestId) return;
    controlState = nextState;
    const { available, mode, mine, inFlight = 0 } = controlState;
    takeover.hidden = !available || !(mode === "ai" || (mode === "paused" && mine));
    takeover.textContent = mode === "paused" ? "继续操作" : "我来操作";
    release.hidden = !available || !mine || mode === "ai";
    release.disabled = busy || inFlight > 0;
    recover.hidden = !available || mode !== "paused" || mine;
    recover.disabled = busy || inFlight > 0;
    takeover.disabled = busy || (mode === "paused" && inFlight > 0);
    document.querySelector('#reconnect').disabled = busy || (mode === 'human' && mine);
    if (available) start.disabled = mode !== "ai";
    start.hidden = controlState.browserReady === true;
    controlStatus.textContent = !available ? "你正在观看助手操作" : {
      ai: controlState.browserStatusAvailable === false ? '正在确认浏览器状态' : controlState.browserReady === false ? '浏览器尚未打开' : controlState.browser?.phase === 'failed' ? '上一步网页操作失败' : `你正在观看 · ${controlState.browser?.displayUrl || '助手的浏览器'}`,
      waiting: "等助手完成当前操作，你就可以接手",
      human: mine ? "现在由你操作 · 助手正在等你" : "另一个页面正在操作 · 你仍可观看",
      paused: inFlight > 0 ? "操作已暂停 · 正在确认上一步是否完成，暂时不能接手或交还" : "操作已暂停 · 你可以继续操作，或让助手继续",
    }[mode];
    const desired = available && mode === "human" && mine && allowHumanConnection ? "human" : "view";
    if (connectionMode !== desired) await connect(desired);
  } catch (err) {
    if (requestId !== statusRequestId) return;
    controlState = { available: false };
    controlStatus.textContent = err.message;
    if (connectionMode === "human") await connect("view");
    takeover.hidden = release.hidden = recover.hidden = true;
  }
}
async function controlAction(action) {
  busy = true; takeover.disabled = release.disabled = recover.disabled = true;
  try {
    const response = await fetch(`/browser/control/${action}`, { method: "POST", headers: controlHeaders() });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "暂时没能切换操作人");
    if (action === 'request' || action === 'resume') allowHumanConnection = true;
    if (result.token) { controller = result.token; sessionStorage.setItem("browser-use-controller", controller); }
    if (action === "release" || action === "recover") { allowHumanConnection = false; controller = null; sessionStorage.removeItem("browser-use-controller"); }
    if (action === 'release' || action === 'recover') {
      status.textContent = result.resumedWaitingTasks > 0 ? '控制已交还，助手正在继续任务' : '控制已交还';
      const message = JSON.stringify({ schemaVersion: 1, type: 'browser.control.returned', epoch: result.epoch, browser: result.browser, resumedWaitingTasks: result.resumedWaitingTasks });
      if (result.schemaVersion === 1) {
        window.ReactNativeWebView?.postMessage(message);
        window.webkit?.messageHandlers?.browserUse?.postMessage(message);
      }
    }
  } catch { status.textContent = "暂时没能切换操作人，请稍后重试"; }
  finally { busy = false; await refreshControl(); }
}
takeover.addEventListener("click", () => controlAction(controlState?.mode === "paused" ? "resume" : "request"));
release.addEventListener("click", () => controlAction("release"));
recover.addEventListener("click", () => controlAction("recover"));
await connect();
await refreshControl();
setInterval(() => { if (!busy) refreshControl(); }, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { allowHumanConnection = false; clearTimeout(reconnectTimer); const old = rfb; rfb = null; old?.disconnect(); }
  else { retries = 0; connectionMode = 'view'; connect('view'); refreshControl(); }
});
window.addEventListener('pagehide', () => { clearTimeout(reconnectTimer); const old = rfb; rfb = null; old?.disconnect(); });
