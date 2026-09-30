import crypto from "node:crypto";
import { WebSocket } from "ws";

const ACTIONS = new Set([
  "status",
  "request",
  "resume",
  "pause",
  "release",
  "recover",
  "input",
  "select",
]);
export function validateTaskInput(value) {
  if (!value || typeof value !== "object")
    throw new Error("Invalid task input");
  if (
    value.type === "text" &&
    typeof value.text === "string" &&
    value.text.length > 0 &&
    value.text.length <= 1024
  )
    return { type: "text", text: value.text };
  if (
    value.type === "key" &&
    [
      "Enter",
      "Tab",
      "Backspace",
      "Delete",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "a", "z", "y",
    ].includes(value.key)
  )
    {
      const modifiers=value.modifiers ?? 0;
      if(!Number.isInteger(modifiers) || modifiers<0 || modifiers>15 || (['a','z','y'].includes(value.key) && !(modifiers&2)))throw new Error('Invalid keyboard shortcut');
      return {type:'key',key:value.key,...(modifiers ? {modifiers} : {})};
    }
  if (
    ["down", "up", "move", "scroll"].includes(value.type) &&
    [value.x, value.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1)
  ) {
    const result = {
      type: value.type,
      x: value.x,
      y: value.y,
      buttons: value.buttons === 1 ? 1 : 0,
    };
    if (value.type === "scroll") {
      if (!Number.isFinite(value.deltaY) || Math.abs(value.deltaY) > 1200)
        throw new Error("Invalid scroll");
      result.deltaY = value.deltaY;
    }
    return result;
  }
  throw new Error("Unsupported task input");
}
export function createTaskBroker({
  rpc,
  fetchImpl = fetch,
  WebSocketImpl = WebSocket,
  dispatch = dispatchTaskInput,
}) {
  // Retain only completion acknowledgements for inputs that this Wrapper has
  // finished dispatching. Reconcile before the next action for the same task;
  // never replay a click/key/text command or expire an unknown input lease.
  const pendingEnds = new Map();
  const authority = async (fields) => {
    const result = await rpc.rpcGateway(
      "browseruse.task-authority",
      fields,
      5000,
    );
    if (!result.ok) throw Object.assign(new Error(result.error?.message || "Task authority refused the request"), { authorityRejected: true });
    return result.payload;
  };
  return async (fields) => {
    if (
      !fields ||
      !ACTIONS.has(fields.action) ||
      typeof fields.browserTaskId !== "string" ||
      fields.browserTaskId.length > 128
    )
      throw new Error("Invalid task request");
    const identity = {
      browserTaskId: fields.browserTaskId,
      ...(fields.nativeSessionId
        ? { nativeSessionId: fields.nativeSessionId }
        : { sessionKey: fields.sessionKey }),
      token: fields.token,
      expectedTargetId: fields.expectedTargetId,
      generation: fields.generation,
      protocolVersion: fields.protocolVersion,
      expectedControlEpoch: fields.expectedControlEpoch,
    };
    const taskKey = JSON.stringify([identity.nativeSessionId || identity.sessionKey, identity.browserTaskId]);
    const settle = async () => {
      const end = pendingEnds.get(taskKey);
      if (!end) return;
      try { await authority(end); }
      catch (error) {
        // A begin may never have reached the Gateway. This only discards our
        // unsent-input acknowledgement; it cannot clear another server lease.
        if (!error.authorityRejected || error.message !== "Input lease mismatch") throw error;
      }
      if (pendingEnds.get(taskKey) === end) pendingEnds.delete(taskKey);
    };
    await settle();
    if (fields.action !== "input") {
      const token =
        fields.action === "request"
          ? crypto.randomBytes(32).toString("hex")
          : fields.token;
      const result = await authority({
        ...identity,
        token,
        action: fields.action,
        ...(fields.action === "select" ? { targetId: fields.targetId } : {}),
      });
      return { ...result, ...(fields.action === "request" ? { token } : {}) };
    }
    const input = validateTaskInput(fields.event),
      callId = crypto.randomUUID();
    let grant;
    try { grant = await authority({ ...identity, action: "input-begin", callId }); }
    catch (error) {
      if (!error.authorityRejected) {
        pendingEnds.set(taskKey, { ...identity, action: "input-end", callId, uncertain: false });
        await settle();
      }
      throw error;
    }
    let uncertain = false,
      pages;
    try {
      pages = await dispatch(grant.targetId, input, {
        rpc,
        fetchImpl,
        WebSocketImpl,
        frameToken: fields.frameToken,
        protocolVersion: grant.protocolVersion,
        minFrameAt: grant.minFrameAt,
      });
      return { ok: true };
    } catch (error) {
      uncertain = error.browserOperationUncertain === true;
      throw new Error(
        uncertain
          ? "Task input interrupted; control is paused"
          : "Task input failed",
      );
    } finally {
      pendingEnds.set(taskKey, {
        ...identity,
        action: "input-end",
        callId,
        uncertain,
        pages,
      });
      await settle();
    }
  };
}
async function dispatchTaskInput(
  targetId,
  input,
  { rpc, fetchImpl, WebSocketImpl },
) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(targetId))
    throw new Error("Invalid target");
  const state = await rpc.rpcGateway(
    "browser.request",
    { method: "GET", path: "/", query: { profile: "openclaw" } },
    3000,
  );
  if (!state.ok || !state.payload?.running || !state.payload?.cdpReady)
    throw new Error("Browser unavailable");
  const endpoint = new URL(state.payload.cdpUrl);
  if (
    endpoint.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Invalid managed endpoint");
  const response = await fetchImpl(new URL("/json/list", endpoint), {
    redirect: "error",
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error("Browser unavailable");
  const tabs = await response.json(),
    target =
      Array.isArray(tabs) &&
      tabs.find((t) => t.id === targetId && t.type === "page");
  if (!target) throw new Error("Task page closed");
  const url = new URL(target.webSocketDebuggerUrl);
  if (
    url.protocol !== "ws:" ||
    url.host !== endpoint.host ||
    url.pathname !== `/devtools/page/${targetId}` ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Invalid page endpoint");
  return await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url.href, { maxPayload: 1024 * 1024 });
    let done = false,
      sentInput = false,
      pending = 0;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) {
        error.browserOperationUncertain = sentInput;
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(() => {
      finish(new Error("Input timeout"));
      socket.terminate();
    }, 5000);
    socket.on("error", () => finish(new Error("Input connection failed")));
    socket.on("close", () => finish(new Error("Input disconnected")));
    socket.on("open", () =>
      socket.send(JSON.stringify({ id: 1, method: "Page.getLayoutMetrics" })),
    );
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data));
        if (!message.id) return;
        if (message.id === 900) {
          finish(null, message.result?.targetInfos || []);
          return;
        }
        if (message.error) throw new Error("Input rejected");
        if (message.id === 1) {
          const viewport = message.result?.cssVisualViewport;
          if (
            !viewport ||
            !Number.isFinite(viewport.clientWidth) ||
            !Number.isFinite(viewport.clientHeight) ||
            viewport.clientWidth <= 0 ||
            viewport.clientHeight <= 0
          )
            throw new Error("Viewport unavailable");
          let commands;
          if (input.type === "text")
            commands = [
              { method: "Input.insertText", params: { text: input.text } },
            ];
          else if (input.type === "key") {
            const codes = {
              Enter: 13,
              Tab: 9,
              Backspace: 8,
              Delete: 46,
              Escape: 27,
              ArrowUp: 38,
              ArrowDown: 40,
              ArrowLeft: 37,
              ArrowRight: 39,
              Home: 36,
              End: 35,
              a: 65,
              z: 90,
              y: 89,
            };
            commands = ["keyDown", "keyUp"].map((type) => ({
              method: "Input.dispatchKeyEvent",
              params: {
                type,
                key: input.key,
                code: /^[azy]$/.test(input.key) ? `Key${input.key.toUpperCase()}` : input.key,
                windowsVirtualKeyCode: codes[input.key],
                ...(input.modifiers ? { modifiers: input.modifiers } : {}),
                ...(type === "keyDown" && input.key === "Enter"
                  ? { text: "\r" }
                  : {}),
              },
            }));
          } else
            commands = [
              {
                method: "Input.dispatchMouseEvent",
                params: {
                  type: {
                    down: "mousePressed",
                    up: "mouseReleased",
                    move: "mouseMoved",
                    scroll: "mouseWheel",
                  }[input.type],
                  x: Math.min(
                    viewport.clientWidth - 1,
                    input.x * viewport.clientWidth,
                  ),
                  y: Math.min(
                    viewport.clientHeight - 1,
                    input.y * viewport.clientHeight,
                  ),
                  button:
                    ["down", "up"].includes(input.type) || input.buttons === 1
                      ? "left"
                      : "none",
                  buttons: input.type === "down" || input.buttons === 1 ? 1 : 0,
                  ...(["down", "up"].includes(input.type)
                    ? { clickCount: 1 }
                    : {}),
                  ...(input.type === "scroll"
                    ? { deltaX: 0, deltaY: input.deltaY }
                    : {}),
                },
              },
            ];
          pending = commands.length;
          sentInput = true;
          commands.forEach((command, index) =>
            socket.send(JSON.stringify({ id: index + 2, ...command })),
          );
        } else if (--pending === 0) {
          sentInput = false;
          if (input.type === "up" || input.type === "key")
            socket.send(
              JSON.stringify({ id: 900, method: "Target.getTargets" }),
            );
          else finish();
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}
