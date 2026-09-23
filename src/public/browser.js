import RFB from "/browser/novnc/core/rfb.js";
const status = document.querySelector("#status");
const start = document.querySelector("#start");
let rfb;
async function connect() {
  if (rfb) { rfb.disconnect(); rfb = null; }
  status.textContent = "正在连接显示服务…";
  try {
    const response = await fetch("/browser/status");
    if (!response.ok || response.redirected) throw new Error("请先登录，或检查浏览器服务配置");
    const state = await response.json();
    start.disabled = !state.ready;
    if (!state.ready) throw new Error(state.error || "显示服务尚未就绪，请稍后重新连接");
    const url = new URL("/browser/ws", location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new RFB(document.querySelector("#screen"), url.href);
    rfb = client;
    client.viewOnly = true;
    client.scaleViewport = true;
    client.addEventListener("connect", () => { if (rfb === client) status.textContent = "已连接 · 只读预览"; });
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
document.querySelector("#reconnect").addEventListener("click", connect);
connect();
