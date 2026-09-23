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
  status.textContent = "正在连接显示服务…";
  try {
    const response = await fetch("/browser/status");
    if (!response.ok || response.redirected) throw new Error("请先登录，或检查浏览器服务配置");
    const state = await response.json();
    start.disabled = !state.ready || (controlState?.available && controlState.mode !== "ai");
    if (!state.ready) throw new Error(state.error || "显示服务尚未就绪，请稍后重新连接");
    const url = new URL(mode === "human" ? "/browser/control/ws" : "/browser/ws", location.href);
    if (mode === "human") url.searchParams.set("controller", controller);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new RFB(document.querySelector("#screen"), url.href);
    rfb = client;
    client.viewOnly = mode !== "human";
    client.scaleViewport = true;
    client.addEventListener("connect", () => { if (rfb === client) status.textContent = mode === "human" ? "已连接 · 你正在操作" : "已连接 · 只读预览"; });
    client.addEventListener("disconnect", () => { if (rfb === client) status.textContent = "画面连接已断开，请重新连接"; });
    client.addEventListener("securityfailure", () => { if (rfb === client) status.textContent = "画面连接认证失败"; });
  } catch (err) { status.textContent = err.message; }
}
start.addEventListener("click", async () => {
  start.disabled = true;
  status.textContent = "OpenClaw 正在启动浏览器…";
  try {
    const response = await fetch("/browser/start", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "浏览器启动失败");
    status.textContent = "浏览器已启动 · 只读预览";
  } catch (err) { status.textContent = err.message; }
  finally { start.disabled = false; }
});
document.querySelector("#reconnect").addEventListener("click", () => connect(controlState?.mode === "human" && controlState?.mine ? "human" : "view"));
async function refreshControl() {
  const requestId = ++statusRequestId;
  try {
    const response = await fetch("/browser/control/status", { headers: controlHeaders() });
    if (!response.ok) throw new Error("控制服务暂不可用");
    const nextState = await response.json();
    if (requestId !== statusRequestId) return;
    controlState = nextState;
    const { available, mode, mine, inFlight = 0 } = controlState;
    takeover.hidden = !available || !(mode === "ai" || (mode === "paused" && mine));
    takeover.textContent = mode === "paused" ? "继续接管" : "接管浏览器";
    release.hidden = !available || !mine || mode === "ai";
    release.disabled = busy || inFlight > 0;
    recover.hidden = !available || mode !== "paused" || mine;
    recover.disabled = busy || inFlight > 0;
    takeover.disabled = busy;
    if (available) start.disabled = mode !== "ai";
    controlStatus.textContent = !available ? "实时只读预览 · Browser Use 接管插件未启用" : {
      ai: "AI 可操作浏览器 · 你正在观看",
      waiting: `等待 ${inFlight} 个在途操作结束，期间已阻止新的受管操作`,
      human: mine ? "你已接管 · AI 的受管浏览器操作已阻止" : "其他页面正在接管 · 你仍可观看",
      paused: "控制已暂停 · 断线不会自动交还 AI；可继续接管或明确交还",
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
    if (!response.ok) throw new Error(result.error || "控制权切换失败");
    if (result.token) { controller = result.token; sessionStorage.setItem("browser-use-controller", controller); }
    if (action === "release" || action === "recover") { controller = null; sessionStorage.removeItem("browser-use-controller"); }
  } catch (err) { status.textContent = err.message; }
  finally { busy = false; await refreshControl(); }
}
takeover.addEventListener("click", () => controlAction(controlState?.mode === "paused" ? "resume" : "request"));
release.addEventListener("click", () => controlAction("release"));
recover.addEventListener("click", () => controlAction("recover"));
await connect();
await refreshControl();
setInterval(() => { if (!busy) refreshControl(); }, 2000);
