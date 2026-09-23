import RFB from "/browser/novnc/core/rfb.js";
const status = document.querySelector("#status");
const start = document.querySelector("#start");
let rfb;
let controller = sessionStorage.getItem("browser-use-controller");
let controlState = null;
let connectionMode = "view";
let busy = false;
let statusRequestId = 0;
const takeover = document.querySelector("#takeover");
const release = document.querySelector("#release");
const recover = document.querySelector("#recover");
const controlStatus = document.querySelector("#control-status");
const controlHeaders = () => controller ? { "X-Browser-Controller": controller } : {};

async function connect(mode = "view") {
  connectionMode = mode;
  if (rfb) { rfb.disconnect(); rfb = null; }
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
    client.addEventListener("connect", () => { if (rfb === client) status.textContent = mode === "human" ? "已连接 · 现在由你操作" : "已连接 · 你正在观看"; });
    client.addEventListener("disconnect", () => { if (rfb === client) status.textContent = "画面断开了，请重新连接"; });
    client.addEventListener("securityfailure", () => { if (rfb === client) status.textContent = "无法验证访问权限，请重新登录"; });
  } catch (err) { status.textContent = err.message; }
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
document.querySelector("#reconnect").addEventListener("click", () => connect(controlState?.mode === "human" && controlState?.mine ? "human" : "view"));
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
    if (available) start.disabled = mode !== "ai";
    controlStatus.textContent = !available ? "你正在观看助手操作" : {
      ai: "助手可以操作 · 你正在观看",
      waiting: "等助手完成当前操作，你就可以接手",
      human: mine ? "现在由你操作 · 助手正在等你" : "另一个页面正在操作 · 你仍可观看",
      paused: inFlight > 0 ? "操作已暂停 · 正在确认上一步是否完成，暂时不能接手或交还" : "操作已暂停 · 你可以继续操作，或让助手继续",
    }[mode];
    const desired = available && mode === "human" && mine ? "human" : "view";
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
    if (result.token) { controller = result.token; sessionStorage.setItem("browser-use-controller", controller); }
    if (action === "release" || action === "recover") { controller = null; sessionStorage.removeItem("browser-use-controller"); }
  } catch { status.textContent = "暂时没能切换操作人，请稍后重试"; }
  finally { busy = false; await refreshControl(); }
}
takeover.addEventListener("click", () => controlAction(controlState?.mode === "paused" ? "resume" : "request"));
release.addEventListener("click", () => controlAction("release"));
recover.addEventListener("click", () => controlAction("recover"));
await connect();
await refreshControl();
setInterval(() => { if (!busy) refreshControl(); }, 2000);
