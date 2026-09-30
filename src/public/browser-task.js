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
    frameSource = "",
    frameTarget = null,
    frameGeneration = null,
    gesture = null;
  const surface = $("#task-canvas"),
    ctx = surface.getContext("2d");
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
  const command = (action, event) =>
    request("/browser/task-control", {
      ...selection,
      browserTaskId: task.browserTaskId,
      token,
      action,
      ...(event
        ? action === "select"
          ? { targetId: event.targetId }
          : {
              event,
              expectedTargetId: frameTarget,
              generation: frameGeneration,
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
    frameGeneration === task.generation;
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
    $("#takeover").disabled = busy || !state || state.inFlight > 0;
    $("#takeover").textContent = state?.mine ? "继续操作" : "我来操作";
    $("#release").hidden = !state?.mine;
    $("#release").disabled = busy || state?.inFlight > 0;
    $("#release").textContent = "完成并返回聊天";
    $("#keyboard").hidden = !writable();
    $("#pan").hidden = true;
    const tabs = $("#task-tabs");
    tabs.hidden = !(task?.pages?.length > 1);
    if (task?.pages?.length > 1) {
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
      ? "取消页面保留"
      : "保留任务页面";
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
      type: "browser.viewer.state",
      connected: Boolean(frameSource),
      mode: state?.mode || "unknown",
      mine: state?.mine === true,
      epoch: state?.epoch || 0,
      inFlight: state?.inFlight || 0,
      busy,
    });
  }
  async function poll(expected) {
    if (expected !== version || !active) return;
    if (!document.hidden && !busy) {
      try {
        const next = await request("/browser/task-resolve", selection);
        if (expected !== version) return;
        if (!next.browser?.browserTaskId) throw new Error("No matching task");
        if (task && task.browserTaskId !== next.browser.browserTaskId)
          throw new Error("Task changed");
        if (!task) {
          task = next.browser;
          token = sessionStorage.getItem(storageKey());
        } else task = next.browser;
        const nextState = await command("status");
        if (expected !== version) return;
        state = nextState;
        const query = new URLSearchParams({
          sessionId: selection.sessionId,
          browserTaskId: task.browserTaskId,
          viewer: "1",
        });
        const response = await fetch("/browser/task-preview?" + query),
          frame = await response.json();
        if (expected !== version) return;
        if (
          !response.ok ||
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
          if (expected !== version) return;
          surface.width = image.naturalWidth;
          surface.height = image.naturalHeight;
          ctx.drawImage(image, 0, 0);
          frameSource = frame.image;
        }
        frameTarget = frame.targetId;
        frameGeneration = frame.generation;
        $("#status").textContent = task.displayUrl || "任务网页";
        render();
      } catch {
        if (expected === version) {
          frameTarget = null;
          frameGeneration = null;
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
    clearTimeout(timer);
    active = true;
    busy = false;
    selection = { sessionId: detail.sessionId, toolCallId: detail.toolCallId };
    task = null;
    state = null;
    token = null;
    enabled = false;
    frameSource = "";
    frameTarget = null;
    frameGeneration = null;
    pending = Promise.resolve();
    queued = 0;
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
      const result = await command(kind);
      if (expected !== version) {
        if (result.token)
          void request("/browser/task-control", {
            ...previousSelection,
            browserTaskId: previousTask.browserTaskId,
            token: result.token,
            action: "pause",
          }).catch(() => {});
        return;
      }
      if (result.token) {
        token = result.token;
        sessionStorage.setItem(storageKey(), token);
      }
      if (kind === "request" || kind === "resume") enabled = true;
      if (kind === "pause" || kind === "release" || kind === "recover")
        enabled = false;
      state = result;
      if (kind === "release" || kind === "recover") {
        sessionStorage.removeItem(storageKey());
        token = null;
        if (result.mode === "ai") postNative({
          schemaVersion: 1,
          type: "browser.control.returned",
          epoch: result.epoch,
          browser: result.browser,
          resumedWaitingTasks: result.resumedWaitingTasks,
        });
      }
    } catch {
      if (expected !== version) return;
      enabled = false;
      $("#status").textContent = "操作未完成；未知输入保持暂停，请检查后重试";
      postNative({ schemaVersion: 1, type: "browser.viewer.error" });
    } finally {
      if (expected === version) {
        busy = false;
        render();
      }
    }
  }
  function send(event) {
    if (!writable() || queued >= 32) return;
    queued++;
    const expected = version,
      expectedTarget = frameTarget,
      expectedGeneration = frameGeneration;
    pending = pending
      .then(async () => {
        if (
          expected === version &&
          writable() &&
          expectedTarget === frameTarget &&
          expectedGeneration === frameGeneration
        )
          await command("input", event);
      })
      .catch(() => {
        if (expected !== version) return;
        enabled = false;
        $("#status").textContent = "输入中断，请检查页面后明确继续";
        render();
      })
      .finally(() => {
        if (expected === version) queued--;
      });
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
        sessionId: selection.sessionId,
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
    send,
    manage,
    takeover: () => action(state?.mine ? "resume" : "request"),
    retain: () => manage(task?.retained ? "unretain" : "retain"),
  };
}
