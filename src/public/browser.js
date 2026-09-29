import { createScopedTaskViewer } from '/browser/task-viewer.js';
import RFB from "/browser/novnc/core/rfb.js";
const status = document.querySelector("#status");
const start = document.querySelector("#start");
let rfb;
let inputRfb;
const inputScreen = document.querySelector('#input-screen');
let controller = sessionStorage.getItem("browser-use-controller");
let controlState = null;
let connectionMode = "view";
let busy = false;
let statusRequestId = 0;
let reconnectTimer, retries = 0;
let allowHumanConnection = false;
let viewConnected = false, inputConnected = false, zoomed = false, panMode = false;
let displaySize = { width: 2560, height: 1600, scaleFactor: 2 };
let lastBridgeState = '';
let taskSelection = null, selectedTaskId = null, taskReady = false, selectionVersion = 0, selectedTask = null;
const stage = document.querySelector('#stage');
const surface = document.querySelector('#surface');
const pan = document.querySelector('#pan');
const keyboard = document.querySelector('#keyboard');
const keyboardInput = document.querySelector('#keyboard-input');
const embedded = Boolean(window.ReactNativeWebView || window.webkit?.messageHandlers?.browserUse);
if (embedded) document.body?.classList.add("embedded");
const takeover = document.querySelector("#takeover");
const release = document.querySelector("#release");
const recover = document.querySelector("#recover");
const controlStatus = document.querySelector("#control-status");
const controlHeaders = () => controller ? { "X-Browser-Controller": controller } : {};

function postNative(payload) {
  const message = JSON.stringify(payload);
  window.ReactNativeWebView?.postMessage(message);
  window.webkit?.messageHandlers?.browserUse?.postMessage(message);
}
function publishState() {
  const payload = { schemaVersion: 1, type: 'browser.viewer.state', connected: viewConnected,
    mode: controlState?.mode || 'unknown', mine: controlState?.mine === true,
    epoch: controlState?.epoch || 0, inFlight: controlState?.inFlight || 0, busy };
  const serialized = JSON.stringify(payload);
  if (serialized !== lastBridgeState) { lastBridgeState = serialized; postNative(payload); }
}
const scoped = createScopedTaskViewer({ postNative, stopDesktop: () => {
  disconnectInput(); clearTimeout(reconnectTimer); const old = rfb; rfb = null; old?.disconnect();
} });
function updateViewport() {
  if (scoped.active) { const canvas = document.querySelector('#task-canvas'); canvas.style.minWidth = zoomed ? '1000px' : ''; document.querySelector('#zoom').textContent = zoomed ? '适合屏幕' : '放大阅读'; return; }
  // Let noVNC perform scaling inside equal-sized surfaces. External CSS
  // transforms would desynchronize its remote pointer coordinates.
  surface.style.width = zoomed ? `${Math.max(stage.clientWidth, displaySize.width / displaySize.scaleFactor)}px` : '100%';
  surface.style.height = zoomed ? `${Math.max(stage.clientHeight, displaySize.height / displaySize.scaleFactor)}px` : '100%';
  document.querySelector('#zoom').textContent = zoomed ? '适合屏幕' : '放大阅读';
  document.querySelector('#zoom').setAttribute('aria-pressed', String(zoomed));
  pan.hidden = !zoomed || !inputConnected;
  pan.textContent = panMode ? '操作网页' : '移动画面';
  pan.setAttribute('aria-pressed', String(panMode));
  keyboard.hidden = !inputConnected;
  inputScreen.style.pointerEvents = inputConnected && !panMode ? 'auto' : 'none';
}
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(updateViewport).observe(stage);

async function connect(mode = "view") {
  if (scoped.active) return;
  if (mode === 'human') return connectInput();
  disconnectInput();
  clearTimeout(reconnectTimer);
  connectionMode = mode;
  const previous = rfb; rfb = null; previous?.disconnect();
  status.textContent = "正在连接画面…";
  try {
    const response = await fetch("/browser/status");
    if (!response.ok || response.redirected) throw new Error("暂时无法打开画面，请重新登录后再试");
    const state = await response.json();
    if (scoped.active) return;
    if (state.width && state.height && state.scaleFactor) displaySize = state;
    updateViewport();
    start.disabled = !state.ready || (controlState?.available && controlState.mode !== "ai");
    if (!state.ready) throw new Error("画面还没准备好，请稍后重新连接");
    const url = new URL(mode === "human" ? "/browser/control/ws" : "/browser/ws", location.href);
    if (mode === "human") url.searchParams.set("controller", controller);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new RFB(document.querySelector("#screen"), url.href);
    rfb = client;
    client.viewOnly = mode !== "human";
    client.scaleViewport = true;
    client.qualityLevel = 9;
    client.compressionLevel = 2;
    client.addEventListener("connect", () => { if (rfb === client) { viewConnected = true; retries = 0; status.textContent = '画面实时同步'; publishState(); } });
    client.addEventListener("disconnect", () => { if (rfb === client) { viewConnected = false; disconnectInput(); allowHumanConnection = false; connectionMode = 'view'; status.textContent = '画面断开，正在恢复…'; publishState(); retryView(); } });
    client.addEventListener("securityfailure", () => { if (rfb === client) status.textContent = "无法验证访问权限，请重新登录"; });
  } catch (err) { status.textContent = err.message; retryView(); }
}
function disconnectInput() {
  inputConnected = false;
  inputScreen.style.pointerEvents = 'none';
  const old = inputRfb; inputRfb = null; old?.disconnect();
  keyboardInput.blur(); updateViewport();
}
async function connectInput() {
  if (inputRfb || !rfb || !controller) return;
  connectionMode = 'human';
  status.textContent = '正在建立操作连接 · 画面持续观看';
  const url = new URL('/browser/control/ws', location.href);
  url.searchParams.set('controller', controller);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const client = new RFB(inputScreen, url.href); inputRfb = client;
  client.viewOnly = false; client.scaleViewport = rfb.scaleViewport; client.focusOnClick = true;
  client.qualityLevel = 9; client.compressionLevel = 2;
  client.addEventListener('connect', () => { if (inputRfb === client) { inputConnected = true; panMode = false; updateViewport(); status.textContent = '点按操作网页 · 输入时可打开键盘'; } });
  client.addEventListener('disconnect', () => { if (inputRfb === client) { inputRfb = null; inputConnected = false; updateViewport(); keyboardInput.blur(); allowHumanConnection = false; connectionMode = 'view'; if (!busy) status.textContent = '操作连接断开，画面仍可观看。请继续操作或交还。'; } });
  client.addEventListener('securityfailure', () => { if (inputRfb === client) { disconnectInput(); allowHumanConnection = false; connectionMode = 'view'; status.textContent = '无法连接操作，请继续操作或交还。'; } });
}
function retryView() {
  if (document.hidden || retries >= 5) return;
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
document.querySelector('#zoom').addEventListener('click', () => { zoomed = !zoomed; panMode = zoomed; updateViewport(); });
pan.addEventListener('click', () => { panMode = !panMode; updateViewport(); });
let composing = false;
const sentinel = '\u200b';
const canType = () => scoped.active ? scoped.canType : (!taskSelection || taskReady) && inputConnected && inputRfb && controlState?.mode === 'human' && controlState.mine;
window.addEventListener('oneclaw:browser-task', async event => {
  const sessionId = event.detail?.sessionId;
  if (!/^session_[A-Za-z0-9_-]{1,128}$/.test(sessionId || '')) return;
  const toolCallId = event.detail?.toolCallId || undefined;
  if (toolCallId) { await scoped.open(event.detail); return; }
  taskSelection = { sessionId, ...(toolCallId ? { toolCallId } : {}) };
  taskReady = false; selectedTaskId = null; selectedTask = null; document.querySelector('#task-snapshot').hidden = false; disconnectInput(); takeover.disabled = true;
  const version = ++selectionVersion;
  try {
    const response = await fetch('/browser/task-view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(taskSelection) });
    const result = await response.json();
    if (version !== selectionVersion) return;
    selectedTask = result.browser; selectedTaskId = result.browser?.browserTaskId || null;
    if (!response.ok || !selectedTaskId || result.browser.resourceState !== 'live') {
      await showTaskSnapshot();
      status.textContent = '此任务页面已释放或暂时不可用，不能接管其他任务。'; return;
    }
    selectedTaskId = result.browser.browserTaskId;
    await refreshControl();
  } catch { status.textContent = '暂时无法打开此任务画面，请重试。'; }
});
async function showTaskSnapshot() {
  if (!taskSelection) return;
  const version = selectionVersion;
  document.querySelector('#task-snapshot').hidden = false;
  document.querySelector('#task-snapshot-label').textContent = selectedTask?.resourceState === 'live' ? '所选任务的只读画面 · 其他任务正在使用共享桌面' : '任务页面已释放 · 保留最后截图';
  try {
    const query = new URLSearchParams({ sessionId: taskSelection.sessionId, ...(selectedTaskId ? { browserTaskId: selectedTaskId } : { toolCallId: taskSelection.toolCallId || '' }) });
    const response = await fetch('/browser/task-preview?' + query);
    const frame = await response.json();
    if (version === selectionVersion && response.ok && frame.browserTaskId && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame.image || '')) { const image = new Image(); image.src = frame.image; await image.decode(); if (version === selectionVersion && !taskReady) document.querySelector('#task-snapshot-image').src = image.src; }
  } catch { /* Do not substitute the shared desktop for a missing task frame. */ }
}
async function manageTask(action) {
  if (scoped.active) { await scoped.manage(action); return; }
  if (busy || !taskSelection || !selectedTaskId) return;
  if (action === 'close-task' && !window.confirm('关闭此任务网页？保存最后截图后关闭；未提交编辑会丢失，登录资料保留。')) return;
  busy = true;
  try {
    const response = await fetch('/browser/task-manage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: taskSelection.sessionId, browserTaskId: selectedTaskId, action }) });
    const result = await response.json(); if (!response.ok) throw new Error(); selectedTask = result.browser;
    if (action === 'close-task') { taskReady = false; await showTaskSnapshot(); }
  } catch { status.textContent = '任务操作未完成，请重试'; }
  finally { busy = false; await refreshControl(); }
}
document.querySelector('#retain-task').addEventListener('click', () => scoped.active ? scoped.retain() : manageTask(selectedTask?.retained ? 'unretain' : 'retain'));
document.querySelector('#close-task').addEventListener('click', () => manageTask('close-task'));
keyboard.addEventListener('click', () => { if (!canType()) return; panMode = false; updateViewport(); keyboardInput.value = sentinel; keyboardInput.focus(); keyboardInput.setSelectionRange(1, 1); });
function sendTypedText() {
  if (composing || !canType()) return;
  const value = keyboardInput.value;
  if (scoped.active) { const text = value.startsWith(sentinel) ? value.slice(1) : value; if (text) scoped.send({type:'text',text}); else if (!value) scoped.send({type:'key',key:'Backspace'}); keyboardInput.value=sentinel; return; }
  if (!value) inputRfb.sendKey(0xff08);
  else for (const char of value.replace(/^\u200b/, '')) { const point = char.codePointAt(0); inputRfb.sendKey(point <= 255 ? point : 0x01000000 | point); }
  keyboardInput.value = sentinel;
}
keyboardInput.addEventListener('compositionstart', () => { composing = true; });
keyboardInput.addEventListener('compositionend', () => { composing = false; sendTypedText(); });
keyboardInput.addEventListener('input', sendTypedText);
keyboardInput.addEventListener('keydown', event => { if (!composing && canType() && ['Enter', 'Tab'].includes(event.key)) { event.preventDefault(); if (scoped.active) { scoped.send({type:'key',key:event.key}); return; } inputRfb.sendKey(event.key === 'Enter' ? 0xff0d : 0xff09); } });
async function refreshControl() {
  if (scoped.active) return;
  const requestId = ++statusRequestId;
  try {
    const response = await fetch("/browser/control/status", { headers: controlHeaders() });
    if (!response.ok) throw new Error("暂时无法切换操作人");
    const nextState = await response.json();
    if (scoped.active || requestId !== statusRequestId) return;
    controlState = nextState;
    if (selectedTaskId && nextState.browser?.browserTaskId === selectedTaskId) selectedTask = nextState.browser;
    taskReady = Boolean(selectedTaskId && nextState.browser?.browserTaskId === selectedTaskId && nextState.browser?.resourceState === 'live');
    document.querySelector('#task-snapshot').hidden = !taskSelection || taskReady;
    if (taskSelection && !taskReady) void showTaskSnapshot();
    const terminalTask = selectedTask?.resourceState === 'live' && ['completed', 'failed', 'cancelled'].includes(selectedTask?.phase);
    for (const id of ['#retain-task', '#close-task']) { document.querySelector(id).hidden = !terminalTask; document.querySelector(id).disabled = busy || nextState.mode !== 'ai' || nextState.inFlight > 0; }
    document.querySelector('#retain-task').textContent = selectedTask?.retained ? '允许空闲释放' : '保留任务页面';
    const { available, mode, mine, inFlight = 0 } = controlState;
    takeover.hidden = !available || !(mode === "ai" || (mode === "paused" && mine));
    takeover.textContent = mode === "paused" ? "继续操作" : "我来操作";
    release.hidden = !available || !mine || mode === "ai";
    release.textContent = embedded ? '完成并返回聊天' : controlState.browser?.needsContinuation === false ? '交还 AI' : '让助手继续';
    release.disabled = busy || inFlight > 0;
    recover.hidden = !available || mode !== "paused" || mine;
    recover.disabled = busy || inFlight > 0;
    takeover.disabled = (embedded && !taskReady) || (taskSelection && !taskReady) || busy || (mode === "paused" && inFlight > 0);
    document.querySelector('#reconnect').disabled = busy || (mode === 'human' && mine);
    if (available) start.disabled = mode !== "ai";
    start.hidden = controlState.browserReady === true;
    controlStatus.textContent = !available ? "你正在观看助手操作" : {
      ai: controlState.browserStatusAvailable === false ? '正在确认浏览器状态' : controlState.browser?.phase === 'expired' ? '上次任务画面已释放 · 让助手重新打开页面' : controlState.browserReady === false ? '浏览器尚未打开' : controlState.browser?.phase === 'failed' ? '上一步网页操作失败' : `${controlState.browser?.phase === 'completed' ? '任务已完成' : '你正在观看'} · ${controlState.browser?.displayUrl || '助手的浏览器'}`,
      waiting: "等助手完成当前操作，你就可以接手",
      human: mine ? "现在由你操作 · 助手正在等你" : "另一个页面正在操作 · 你仍可观看",
      paused: inFlight > 0 ? "AI 控制已暂停 · 有未确认结束的操作，需要维护恢复" : "操作已暂停 · 你可以继续操作，或让助手继续",
    }[mode];
    const desired = available && mode === "human" && mine && allowHumanConnection && (!taskSelection || taskReady) ? "human" : "view";
    if (connectionMode !== desired) {
      if (desired === 'human') await connectInput();
      else { disconnectInput(); connectionMode = 'view'; status.textContent = '已连接 · 你正在观看'; }
    }
    if (taskSelection && !taskReady) controlStatus.textContent = '当前共享画面不属于所选任务 · 接管已禁用';
    else if (controlState.queuedBrowser) controlStatus.textContent += ` · ${controlState.queuedBrowser} 个浏览器步骤排队中`;
    publishState();
  } catch (err) {
    if (scoped.active || requestId !== statusRequestId) return;
    controlState = { available: false };
    controlStatus.textContent = err.message;
    if (connectionMode === "human") { disconnectInput(); connectionMode = 'view'; }
    takeover.hidden = release.hidden = recover.hidden = true;
    publishState();
  }
}
async function controlAction(action) {
  if (scoped.active) { if (action === 'request' || action === 'resume') await scoped.takeover(); else await scoped.action(action); return; }
  if (busy || (['request', 'resume'].includes(action) && ((embedded && !taskReady) || (taskSelection && !taskReady)))) return;
  busy = true; publishState(); takeover.disabled = release.disabled = recover.disabled = true;
  try {
    const response = await fetch(`/browser/control/${action}${selectedTaskId && ['request', 'resume'].includes(action) ? '?browserTaskId=' + encodeURIComponent(selectedTaskId) : ''}`, { method: "POST", headers: controlHeaders() });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "暂时没能切换操作人");
    if (action === 'request' || action === 'resume') allowHumanConnection = true;
    if (result.token) { controller = result.token; sessionStorage.setItem("browser-use-controller", controller); }
    if (action === "release" || action === "recover") { allowHumanConnection = false; controller = null; sessionStorage.removeItem("browser-use-controller"); }
    if (action === 'release' || action === 'recover') {
      status.textContent = result.resumedWaitingTasks > 0 ? '控制已交还，助手正在继续任务' : '控制已交还';
      const message = { schemaVersion: 1, type: 'browser.control.returned', epoch: result.epoch, browser: result.browser, resumedWaitingTasks: result.resumedWaitingTasks };
      if (result.schemaVersion === 1) {
        postNative(message);
      }
    }
  } catch { status.textContent = "暂时没能切换操作人，请稍后重试"; postNative({ schemaVersion: 1, type: 'browser.viewer.error' }); }
  finally { busy = false; await refreshControl(); }
}
takeover.addEventListener("click", () => controlAction(controlState?.mode === "paused" ? "resume" : "request"));
release.addEventListener("click", () => controlAction("release"));
recover.addEventListener("click", () => controlAction("recover"));
window.addEventListener('oneclaw:browser-command', event => {
  if (event.detail?.action === 'pause' && scoped.active) { void scoped.action('pause'); return; }
  if (event.detail?.action !== 'release') return;
  if (scoped.active) { void scoped.action('release'); return; }
  if (!busy && controlState?.mine && controlState.inFlight === 0) void controlAction('release');
  else postNative({ schemaVersion: 1, type: 'browser.viewer.error' });
});
// Native load callbacks can precede module evaluation. Preserve the selector
// across that race instead of briefly opening a shared desktop for a task.
if (window.__oneclawBrowserTask) window.dispatchEvent(new CustomEvent('oneclaw:browser-task', { detail: window.__oneclawBrowserTask }));
await connect();
await refreshControl();
setInterval(() => { if (!busy && !document.hidden) refreshControl(); }, 2000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { allowHumanConnection = false; disconnectInput(); clearTimeout(reconnectTimer); const old = rfb; rfb = null; old?.disconnect(); }
  else { retries = 0; connectionMode = 'view'; connect('view'); refreshControl(); }
});
window.addEventListener('pagehide', () => { disconnectInput(); clearTimeout(reconnectTimer); const old = rfb; rfb = null; old?.disconnect(); });
