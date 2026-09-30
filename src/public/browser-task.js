/** Task-addressed page transport; no desktop focus or global input connection. */
export function createScopedTaskViewer({ postNative, stopDesktop }) {
  const $ = (id) => document.querySelector(id);
  let active = false,
    selection,
    task,
    state,
    token,
    enabled = false,
    busy = false,
    version = 0,
    timer,
    pending = Promise.resolve(),
    queued = 0,
    draining = false,
    inputFailed = false,
    frameSource = "",
    frameTarget = null,
    frameGeneration = null,
    frameToken = null,
    frameCapturedAt = 0,
    tabsRevision = "",
    gesture = null;
  const surface = $("#task-canvas"),
    ctx = surface.getContext("2d");
  const sessionFields = () => selection?.sessionKey ? { sessionKey: selection.sessionKey } : { sessionId: selection.sessionId };
  const storageKey = () => `browser-task:${task.browserTaskId}`;
  const request = async (path, body) => {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("Task unavailable");
    return response.json();
  };
  const command = (action, event, observed = { targetId: frameTarget, generation: frameGeneration, frameToken, epoch: state?.epoch }) =>
    request("/browser/task-control", {
      ...selection,
      browserTaskId: task.browserTaskId,
      token,
      action,
      protocolVersion: 2,
      expectedControlEpoch: observed.epoch,
      ...(event
        ? action === "select"
          ? { targetId: event.targetId }
          : {
              event,
              expectedTargetId: observed.targetId,
              generation: observed.generation,
              frameToken: observed.frameToken,
            }
        : {}),
    });
  const writable = () =>
    active &&
    enabled &&
    !busy &&
    state?.mine &&
    state.mode === "human" &&
    task?.resourceState === "live" &&
    frameTarget === task.targetId &&
    frameGeneration === task.generation &&
    (!state.grantedAt || frameCapturedAt >= state.grantedAt);
  function render() {
    $("#task-snapshot").hidden = true;
    $("#scoped-task").hidden = false;
    $("#screen").hidden = true;
    $("#input-screen").hidden = true;
    $("#start").hidden = true;
    $("#recover").hidden = state?.mode !== "paused" || state?.mine === true || state?.controlScope === "runtime";
    $("#recover").disabled = busy || state?.inFlight > 0;
    $("#takeover").hidden =
      !task ||
      task.resourceState !== "live" ||
      (state?.mode !== "ai" && !state?.mine);
    $("#takeover").disabled = busy || !state || (state.mine && state.inFlight > 0);
    $("#takeover").textContent = state?.mine ? "继续操作" : "我来操作";
    $("#release").hidden = !state?.mine;
    $("#release").disabled = busy || state?.inFlight > 0;
    $("#release").textContent = "完成并返回聊天";
    $("#keyboard").hidden = !writable();
    $("#pan").hidden = true;
    const tabs = $("#task-tabs");
    tabs.hidden = !(task?.pages?.length > 1);
    const nextTabsRevision = JSON.stringify([task?.browserTaskId, task?.pages, task?.targetId, state?.mine, state?.mode, busy]);
    if (task?.pages?.length > 1 && nextTabsRevision !== tabsRevision) {
      tabsRevision = nextTabsRevision;
      tabs.replaceChildren();
      task.pages.forEach((page, index) => {
        const button = document.createElement("button");
        button.textContent = page.displayUrl || `页面 ${index + 1}`;
        button.disabled = !state?.mine || state.mode !== "human" || busy;
        button.setAttribute(
          "aria-pressed",
          String(task.targetId === page.targetId),
        );
        button.addEventListener("click", async () => {
          if (busy) return;
          busy = true;
          const expected = version;
          render();
          try {
            const nextState = await command("select", { targetId: page.targetId });
            if (expected !== version) return;
            state = nextState;
            task = state.browser;
          } catch {
            if (expected === version) $("#status").textContent = "切换页面失败";
          } finally {
            if (expected === version) { busy = false; render(); }
          }
        });
        tabs.append(button);
      });
    }
    const terminal =
      task?.resourceState === "live" &&
      ["completed", "failed", "cancelled"].includes(task.phase);
    for (const id of ["#retain-task", "#close-task"]) {
      $(id).hidden = !terminal;
      $(id).disabled = busy || state?.mode !== "ai";
    }
    $("#retain-task").textContent = task?.retained
      ? "恢复自动清理"
      : "保留页面供稍后使用";
    $("#control-status").textContent = !task
      ? "正在定位任务"
      : task.resourceState !== "live"
        ? "任务网页已释放 · 最后截图"
        : state?.mode === "waiting"
          ? "等待此任务当前步骤结束"
          : state?.mode === "paused"
            ? state?.mine ? "你已暂停操作 · 可继续或交还 AI" : "此任务已暂停"
            : writable()
              ? "你正在操作此任务 · 其他任务可继续"
              : state?.mode === "human"
                ? state?.mine ? "已接管 · 点击继续操作" : "此任务已被接管"
                : "此任务的实时画面";
    surface.style.touchAction = writable() ? "none" : "auto";
    postNative({
      schemaVersion: 1,
      viewerProtocolVersion: 2,
      viewerId: selection?.viewerId,
      sessionId: selection?.sessionId,
      toolCallId: selection?.toolCallId,
      browserTaskId: task?.browserTaskId,
      generation: task?.generation,
      type: "browser.viewer.state",
      connected: Boolean(frameSource),
      mode: state?.mode || "unknown",
      mine: state?.mine === true,
      epoch: state?.epoch || 0,
      inFlight: state?.inFlight || 0,
      busy,
    });
  }
  let media = null, mediaAttempted = false, lastMediaAt = 0, paintRevision = 0, nativeVisible = true, retryMediaAt = 0, latestCaptureAt = 0;
  async function paint(frame, expected) {
    if (expected !== version || !task) return;
    if (frame.resourceState === 'live' && frame.capturedAt && frame.capturedAt < latestCaptureAt) return;
    latestCaptureAt = frame.capturedAt || latestCaptureAt;
    const revision = ++paintRevision;
    if (
      frame.browserTaskId !== task.browserTaskId ||
      (frame.resourceState === "live" &&
        (frame.generation !== task.generation ||
          frame.targetId !== task.targetId)) ||
      frame.image?.length > 700000 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame.image || "")
    )
      throw new Error("Preview unavailable");
    if (frameSource !== frame.image) {
      const image = new Image();
      image.src = frame.image;
      await image.decode();
      if (expected !== version || revision !== paintRevision) return;
      // Assigning even the same canvas dimensions clears its current frame.
      if (surface.width !== image.naturalWidth) surface.width = image.naturalWidth;
      if (surface.height !== image.naturalHeight) surface.height = image.naturalHeight;
      ctx.drawImage(image, 0, 0);
      frameSource = frame.image;
    }
    if (revision !== paintRevision) return;
    frameTarget = frame.targetId;
    frameGeneration = frame.generation;
    frameToken = frame.frameToken;
    frameCapturedAt = frame.capturedAt || 0;
    $("#status").textContent = task.displayUrl || "任务网页";
    render();
  }
  function startMedia(expected) {
    if (Date.now() < retryMediaAt || !nativeVisible || mediaAttempted || task?.resourceState !== 'live' || typeof WebSocket === 'undefined' || typeof location === 'undefined') return;
    mediaAttempted = true;
    const url = new URL('/browser/task-stream', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    for (const [key, value] of Object.entries(sessionFields())) url.searchParams.set(key, value);
    url.searchParams.set('browserTaskId', task.browserTaskId);
    const socket = new WebSocket(url.href); media = socket; socket.binaryType = 'arraybuffer';
    socket.onmessage = event => {
      if (media !== socket || expected !== version || document.hidden) return;
      try {
        const bytes = new Uint8Array(event.data);
        if (bytes.length < 5 || bytes.length > 720000) throw new Error('Invalid frame');
        const length = new DataView(event.data).getUint32(0);
        if (length > 8192 || length + 4 >= bytes.length) throw new Error('Invalid metadata');
        const frame = JSON.parse(new TextDecoder().decode(bytes.subarray(4, length + 4)));
        const image = bytes.subarray(length + 4);
        if (image[0] !== 255 || image[1] !== 216) throw new Error('Invalid JPEG');
        let binary = '';
        for (let i = 0; i < image.length; i += 8192) binary += String.fromCharCode(...image.subarray(i, i + 8192));
        frame.image = 'data:image/jpeg;base64,' + btoa(binary);
        void paint(frame, expected).then(() => { if (media === socket) lastMediaAt = Date.now(); }).catch(() => { lastMediaAt = 0; });
      } catch { lastMediaAt = 0; socket.close(); }
    };
    socket.onerror = () => { lastMediaAt = 0; };
    socket.onclose = () => { if (media === socket) { media = null; lastMediaAt = 0; mediaAttempted = false; retryMediaAt = Date.now() + 5000; } };
  }
  async function poll(expected) {
    if (expected !== version || !active) return;
    if (nativeVisible && !document.hidden && !busy) {
      try {
        const next = await request("/browser/task-resolve", selection);
        if (expected !== version) return;
        if (!next.browser?.browserTaskId) throw new Error("No matching task");
        if (task && task.browserTaskId !== next.browser.browserTaskId)
          throw new Error("Task changed");
        if (!task) {
          task = next.browser;
          selection.browserTaskId = task.browserTaskId;
          token = sessionStorage.getItem(storageKey());
        } else task = next.browser;
        const nextState = await command("status");
        if (expected !== version) return;
        state = nextState;
        startMedia(expected);
        if (Date.now() - lastMediaAt >= 2000) {
        const query = new URLSearchParams({
          ...sessionFields(),
          browserTaskId: task.browserTaskId,
          viewer: "1",
        });
        const response = await fetch("/browser/task-preview?" + query),
          frame = await response.json();
        if (expected !== version) return;
        if (!response.ok) throw new Error("Preview unavailable");
        await paint(frame, expected);
        }
      } catch {
        if (expected === version) {
          frameTarget = null;
          frameGeneration = null;
          frameToken = null;
          $("#status").textContent = "任务画面暂不可用，正在重试";
          render();
        }
      }
    }
    if (expected === version) timer = setTimeout(() => poll(expected), 1000);
  }
  async function open(detail) {
    enabled = false;
    if (active && token && task) await command("pause").catch(() => {});
    version++;
    media?.close(); media = null; mediaAttempted = false; lastMediaAt = 0; latestCaptureAt = 0; retryMediaAt = 0;
    clearTimeout(timer);
    active = true;
    busy = false;
    selection = { ...(detail.sessionKey ? { sessionKey: detail.sessionKey } : { sessionId: detail.sessionId }), toolCallId: detail.toolCallId, browserTaskId: detail.browserTaskId, viewerId: detail.viewerId };
    task = null;
    state = null;
    token = null;
    enabled = false;
    frameSource = "";
    frameTarget = null;
    frameGeneration = null;
    frameToken = null;
    pending = Promise.resolve();
    queued = 0;
    inputFailed = false;
    draining = false;
    ctx.clearRect(0, 0, surface.width, surface.height);
    stopDesktop();
    render();
    void poll(version);
  }
  async function action(kind) {
    if (!active || !task || busy) return;
    busy = true;
    render();
    const expected = version,
      previousTask = task,
      previousSelection = selection;
    try {
      if (kind === 'release') { draining = true; await pending; draining = false; if (inputFailed) throw new Error('Inspect interrupted input before handback'); }
      const result = await command(kind);
      if (expected !== version) {
        if (result.token)
          void request("/browser/task-control", {
            ...previousSelection,
            browserTaskId: previousTask.browserTaskId,
            token: result.token,
            expectedControlEpoch: result.epoch,
            action: "pause",
          }).catch(() => {});
        return;
      }
      if (result.token) {
        token = result.token;
        sessionStorage.setItem(storageKey(), token);
      }
      if (kind === "request" || kind === "resume") {
        enabled = true;
        inputFailed = false;
        if (result.controlProtocolVersion === 2) { frameTarget = null; frameGeneration = null; frameToken = null; }
      }
      if (kind === "pause" || kind === "release" || kind === "recover")
        enabled = false;
      state = result;
      if (kind === "release" || kind === "recover") {
        sessionStorage.removeItem(storageKey());
        token = null;
        if (result.mode === "ai") postNative({
          schemaVersion: 1,
          viewerProtocolVersion: 2,
          viewerId: selection?.viewerId,
          sessionId: selection?.sessionId,
          toolCallId: selection?.toolCallId,
          browserTaskId: task?.browserTaskId,
          generation: task?.generation,
          type: "browser.control.returned",
          epoch: result.epoch,
          browser: result.browser,
          resumedWaitingTasks: result.resumedWaitingTasks,
          continuation: result.continuation,
        });
      }
    } catch {
      if (expected !== version) return;
      enabled = false;
      $("#status").textContent = "操作未完成；未知输入保持暂停，请检查后重试";
      postNative({ schemaVersion: 1, viewerProtocolVersion: 2, viewerId: selection?.viewerId, sessionId: selection?.sessionId, toolCallId: selection?.toolCallId, type: "browser.viewer.error" });
    } finally {
      if (expected === version) {
        busy = false;
        render();
      }
    }
  }
  function send(event) {
    if (!writable()) return false;
    if (queued >= 256 && event.type !== 'up') {
      $("#status").textContent = "输入仍在处理中，请稍后继续";
      return false;
    }
    queued++;
    const expected = version,
      expectedTarget = frameTarget,
      expectedGeneration = frameGeneration;
    const observed = { targetId: frameTarget, generation: frameGeneration, frameToken, epoch: state?.epoch };
    pending = pending
      .then(async () => {
        if (
          expected === version &&
          observed.epoch === state?.epoch &&
          (writable() || draining) &&
          expectedTarget === frameTarget &&
          expectedGeneration === frameGeneration
        )
          await command("input", event, observed);
      })
      .catch(() => {
        if (expected !== version || observed.epoch !== state?.epoch) return;
        draining = false;
        inputFailed = true;
        enabled = false;
        $("#status").textContent = "输入中断，请检查页面后明确继续";
        render();
      })
      .finally(() => {
        if (expected === version) queued--;
      });
    return true;
  }
  function point(event) {
    const r = surface.getBoundingClientRect(),
      scale = Math.min(r.width / surface.width, r.height / surface.height),
      w = surface.width * scale,
      h = surface.height * scale,
      x = (event.clientX - r.left - (r.width - w) / 2) / w,
      y = (event.clientY - r.top - (r.height - h) / 2) / h;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }
  surface.addEventListener("pointerdown", (event) => {
    const p = point(event);
    if (p && writable()) {
      surface.setPointerCapture(event.pointerId);
      if (event.pointerType === "touch")
        gesture = { y: event.clientY, moved: false };
      else send({ type: "down", ...p });
    }
  });
  surface.addEventListener("pointermove", (event) => {
    const p = point(event);
    if (!p) return;
    if (gesture && Math.abs(gesture.y - event.clientY) > 5) {
      gesture.moved = true;
      send({
        type: "scroll",
        ...p,
        deltaY: Math.max(-1200, Math.min(1200, gesture.y - event.clientY)),
      });
      gesture.y = event.clientY;
    } else if (!gesture && event.buttons === 1)
      send({ type: "move", ...p, buttons: 1 });
  });
  surface.addEventListener("pointerup", (event) => {
    const p = point(event),
      g = gesture;
    gesture = null;
    if (p && (!g || !g.moved)) {
      if (g) send({ type: "down", ...p });
      send({ type: "up", ...p });
    }
  });
  surface.addEventListener("pointercancel", (event) => {
    gesture = null;
    const p = point(event);
    if (p) send({ type: "up", ...p });
  });
  surface.addEventListener(
    "wheel",
    (event) => {
      const p = point(event);
      if (p && writable()) {
        event.preventDefault();
        send({
          type: "scroll",
          ...p,
          deltaY: Math.max(-1200, Math.min(1200, event.deltaY)),
        });
      }
    },
    { passive: false },
  );
  async function manage(kind) {
    if (!active || !task || busy) return;
    if (
      kind === "close-task" &&
      !window.confirm(
        "关闭此任务网页？保存截图后关闭；未提交编辑会丢失，登录资料保留。",
      )
    )
      return;
    busy = true;
    const expected = version;
    try {
      const result = await request("/browser/task-manage", {
        ...sessionFields(),
        browserTaskId: task.browserTaskId,
        action: kind,
      });
      if (expected !== version) return;
      task = result.browser;
    } catch {
      if (expected === version) $("#status").textContent = "任务操作未完成，请重试";
    } finally {
      if (expected === version) { busy = false; render(); }
    }
  }
  const pause = () => {
    enabled = false;
    media?.close(); media = null; mediaAttempted = false; lastMediaAt = 0;
    if (token && task) void command("pause").catch(() => {});
    render();
  };
  document.addEventListener("visibilitychange", () => {
    if (active && document.hidden) pause();
  });
  window.addEventListener("pagehide", () => {
    if (active) pause();
  });
  return {
    dispose: () => {
      if (active) pause();
      active = false;
      version++;
      clearTimeout(timer);
    },
    get active() {
      return active;
    },
    get mine() {
      return state?.mine;
    },
    get canType() {
      return writable();
    },
    open,
    action,
    pause,
    suspend: () => { nativeVisible = false; pause(); },
    foreground: () => { nativeVisible = true; },
    send,
    manage,
    takeover: () => action(state?.mine ? "resume" : "request"),
    retain: () => manage(task?.retained ? "unretain" : "retain"),
  };
}
