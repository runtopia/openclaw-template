import crypto from 'node:crypto';
import { WebSocket } from 'ws';

function loopback(value, protocols) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw new Error('Invalid managed browser endpoint');
  return url;
}

// One persistent, bounded CDP session per page. No focus, browser start, or
// fallback to a different target. Connections disappear with their page.
export function createBrowserPagePool({ rpc, fetchImpl = fetch, WebSocketImpl = WebSocket, now = Date.now }) {
  const pages = new Map();
  const frames = new Map();
  const casts = new Map();
  let stopped = false;
  async function connect(targetId) {
    if (stopped || !/^[A-Za-z0-9_-]{1,128}$/.test(targetId)) throw new Error('Invalid browser target');
    let entry = pages.get(targetId);
    if (entry) { entry.used = now(); return entry.ready; }
    if (pages.size >= 32) throw new Error('Browser page connection capacity reached');
    entry = { used: now(), close: () => {}, ready: null };
    pages.set(targetId, entry);
    entry.ready = (async () => {
      const result = await rpc.rpcGateway('browser.request', { method: 'GET', path: '/', query: { profile: 'openclaw' } }, 3000);
      if (!result.ok || !result.payload?.running || !result.payload?.cdpReady) throw new Error('Browser unavailable');
      const endpoint = loopback(result.payload.cdpUrl, ['http:']);
      const response = await fetchImpl(new URL('/json/list', endpoint), { redirect: 'error', signal: AbortSignal.timeout(2000) });
      if (!response.ok) throw new Error('Browser unavailable');
      const list = await response.json();
      const page = Array.isArray(list) && list.find(item => item.id === targetId && item.type === 'page');
      if (!page) throw new Error('Task page closed');
      const url = loopback(page.webSocketDebuggerUrl, ['ws:']);
      if (url.host !== endpoint.host || url.pathname !== `/devtools/page/${targetId}`) throw new Error('Invalid page endpoint');
      if (stopped) throw new Error('Browser service stopped');
      return new Promise((resolve, reject) => {
        const socket = new WebSocketImpl(url.href, { maxPayload: 2 * 1024 * 1024 });
        let serial = 0, closed = false;
        const pending = new Map(), events = new Map();
        const close = () => {
          if (closed) return;
          closed = true;
          clearTimeout(openTimer);
          if (pages.get(targetId) === entry) pages.delete(targetId);
          for (const [token, frame] of frames) if (frame.targetId === targetId) frames.delete(token);
          for (const call of pending.values()) { clearTimeout(call.timer); call.reject(Object.assign(new Error('Browser transport interrupted'), { browserOperationUncertain: call.input })); }
          pending.clear();
          const cast = casts.get(targetId);
          if (cast) { cast.closed = true; cast.detach?.(); casts.delete(targetId); }
          socket.terminate();
          reject(new Error('Browser page connection closed'));
        };
        entry.close = close;
        const openTimer = setTimeout(close, 3000);
        function call(method, params = {}, input = false) {
          if (closed) return Promise.reject(new Error('Browser page connection closed'));
          entry.used = now();
          const id = ++serial;
          return new Promise((done, fail) => {
            const timer = setTimeout(close, 5000);
            pending.set(id, { resolve: done, reject: fail, timer, input });
            try { socket.send(JSON.stringify({ id, method, params })); } catch { close(); }
          });
        }
        socket.on('message', data => {
          try {
            const value = JSON.parse(String(data));
            if (value.method) { for (const handler of events.get(value.method) || []) handler(value.params || {}); return; }
            const waiter = pending.get(value.id);
            if (!waiter) return;
            pending.delete(value.id); clearTimeout(waiter.timer);
            if (value.error) waiter.reject(Object.assign(new Error('Browser operation rejected'), { browserOperationUncertain: waiter.input }));
            else waiter.resolve(value.result || {});
          } catch { close(); }
        });
        socket.on('error', close); socket.on('close', close);
        socket.on('open', () => { clearTimeout(openTimer); resolve({ call, on: (name, handler) => { const set = events.get(name) || new Set(); set.add(handler); events.set(name, set); return () => set.delete(handler); } }); });
      });
    })().catch(error => { if (pages.get(targetId) === entry) pages.delete(targetId); throw error; });
    return entry.ready;
  }
  async function view(connection) {
    const [layout, tree] = await Promise.all([connection.call('Page.getLayoutMetrics'), connection.call('Page.getFrameTree')]);
    const v = layout.cssVisualViewport, document = tree.frameTree?.frame;
    if (!v || !document?.loaderId || ![v.clientWidth, v.clientHeight, v.pageX, v.pageY].every(Number.isFinite)
        || v.clientWidth <= 0 || v.clientHeight <= 0) throw new Error('Page viewport unavailable');
    return { ...v, document: `${document.id}:${document.loaderId}` };
  }
  const geometry = value => JSON.stringify([value.document, value.clientWidth, value.clientHeight]);
  const signature = value => JSON.stringify([value.document, value.clientWidth, value.clientHeight, value.pageX, value.pageY]);
  function observedFrame(targetId, viewport, at) {
    const frameToken = crypto.randomBytes(24).toString("hex");
    frames.set(frameToken, { targetId, signature: signature(viewport), geometry: geometry(viewport), at });
    for (const [token, frame] of frames) if (now() - frame.at > 10000) frames.delete(token);
    while (frames.size > 256) frames.delete(frames.keys().next().value);
    return frameToken;
  }
  async function capture(targetId, { viewer = false, minFrameAt = 0 } = {}) {
    const startedAt = now();
    const connection = await connect(targetId);
    const recent = casts.get(targetId)?.frame;
    if (viewer && recent && recent.capturedAt>=minFrameAt && now() - recent.capturedAt < 500) return recent;
    const before = await view(connection);
    // A CDP clip temporarily emulates/resizes the renderer, even for a read-only
    // screenshot. Concurrent thumbnail/live captures then disturb the headed
    // desktop and can restore each other's temporary viewport. Capture the
    // existing surface whole; bound bandwidth with JPEG quality, never geometry.
    let result;
    for (const quality of viewer ? [80, 60, 40] : [60, 40]) {
      result = await connection.call('Page.captureScreenshot', {
        format: 'jpeg', quality, captureBeyondViewport: false, fromSurface: true,
      });
      if (typeof result.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(result.data)) throw new Error('Invalid browser frame');
      if (result.data.length <= 680000) break;
    }
    const after = await view(connection);
    if (signature(before) !== signature(after)) throw new Error('Page changed during capture');
    if (typeof result.data !== 'string' || result.data.length > 680000 || !/^[A-Za-z0-9+/=]+$/.test(result.data)) throw new Error('Invalid browser frame');
    const frameToken = observedFrame(targetId, after, startedAt);
    return { image: `data:image/jpeg;base64,${result.data}`, frameToken, capturedAt:startedAt };
  }
  async function dispatch(targetId, input, options = {}) {
    const connection = await connect(targetId), viewport = await view(connection);
    if (options.protocolVersion === 2) {
      const frame = frames.get(options.frameToken);
      if (!frame || frame.targetId !== targetId || frame.at < (options.minFrameAt || 0) || now() - frame.at > 10000 || (frame.signature !== signature(viewport) && !( ['text', 'key', 'scroll', 'move', 'up'].includes(input.type) && frame.geometry === geometry(viewport) )))
        throw new Error('Stale task frame; refresh before input');
    }
    try {
    if (input.type === 'text') await connection.call('Input.insertText', { text: input.text }, true);
    else if (input.type === 'key') {
      const codes = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, a:65, z:90, y:89 };
      await connection.call('Input.dispatchKeyEvent', { type: 'keyDown', key: input.key, code: /^[azy]$/.test(input.key) ? 'Key'+input.key.toUpperCase() : input.key, windowsVirtualKeyCode: codes[input.key], modifiers: input.modifiers || 0, ...(input.key === 'Enter' ? { text: '\r' } : {}) }, true);
      await connection.call('Input.dispatchKeyEvent', { type: 'keyUp', key: input.key, code: input.key, windowsVirtualKeyCode: codes[input.key] }, true);
    } else await connection.call('Input.dispatchMouseEvent', {
      type: { down: 'mousePressed', up: 'mouseReleased', move: 'mouseMoved', scroll: 'mouseWheel' }[input.type],
      x: Math.min(viewport.clientWidth - 1, input.x * viewport.clientWidth), y: Math.min(viewport.clientHeight - 1, input.y * viewport.clientHeight),
      button: ['down', 'up'].includes(input.type) || input.buttons === 1 ? 'left' : 'none', buttons: input.type === 'down' || input.buttons === 1 ? 1 : 0,
      ...(['down', 'up'].includes(input.type) ? { clickCount: 1 } : {}), ...(input.type === 'scroll' ? { deltaX: 0, deltaY: input.deltaY } : {}),
    }, true);
    } catch (error) { error.browserOperationUncertain = true; throw error; }
    // Input acknowledgement already proves delivery; a failed read-only popup
    // inventory must not reclassify that input as unknown or replay it.
    return (await connection.call('Target.getTargets').catch(() => ({}))).targetInfos || [];
  }
  // Page.startScreencast scales encoded frames without resizing the renderer.
  // A single cast per target fans out to viewers, with latest-frame backpressure.
  async function subscribe(targetId, listener) {
    const connection = await connect(targetId);
    let cast = casts.get(targetId);
    if (!cast) {
      cast = { listeners: new Set(), closed: false, epoch: 0, busy: false, latest: null, frame: null };
      casts.set(targetId, cast);
      const navigate = connection.on('Page.frameNavigated', ({frame}) => { if (!frame?.parentId) cast.epoch++; });
      const receive = connection.on('Page.screencastFrame', frame => {
        void connection.call('Page.screencastFrameAck', {sessionId:frame.sessionId}).catch(() => {});
        if (cast.closed || typeof frame.data !== 'string' || frame.data.length > 680000 || !/^[A-Za-z0-9+/=]+$/.test(frame.data)) return;
        const timestamp=Number(frame.metadata?.timestamp)*1000;
        cast.latest = {frame, epoch:cast.epoch, at:Number.isFinite(timestamp) && timestamp>0 ? Math.min(now(),Math.round(timestamp)) : now()};
        void paintLatest();
      });
      cast.detach = () => { navigate(); receive(); };
      async function paintLatest() {
        if (cast.busy || cast.closed || !cast.latest) return;
        cast.busy = true;
        const sample = cast.latest; cast.latest = null;
        try {
          const viewport = await view(connection);
          const metadata = sample.frame.metadata || {};
          if (cast.closed || sample.epoch !== cast.epoch || now()-sample.at > 1000
              || (Number.isFinite(metadata.scrollOffsetY) && Math.abs(metadata.scrollOffsetY-viewport.pageY) > 1)) return;
          const frameToken = observedFrame(targetId, viewport, sample.at);
          cast.frame = {image:'data:image/jpeg;base64,'+sample.frame.data, frameToken, capturedAt:sample.at};
          for (const fn of cast.listeners) fn(cast.frame);
        } catch { /* A missing frame must never become a different page. */ }
        finally { cast.busy=false; if (cast.latest && !cast.closed) queueMicrotask(paintLatest); }
      }
      cast.ready = (async () => {
        await connection.call('Page.enable');
        await connection.call('Page.startScreencast', {format:'jpeg',quality:65,maxWidth:1440,maxHeight:1000,everyNthFrame:1});
      })().catch(error => { cast.closed=true; cast.detach(); if(casts.get(targetId)===cast)casts.delete(targetId); throw error; });
    }
    cast.listeners.add(listener);
    try { await cast.ready; } catch(error) { cast.listeners.delete(listener); throw error; }
    if (cast.frame) listener(cast.frame);
    let removed=false;
    const remove = () => {
      if (removed) return; removed=true; cast.listeners.delete(listener);
      if (!cast.listeners.size && casts.get(targetId)===cast) {
        cast.closed=true; cast.detach(); casts.delete(targetId);
        void connection.call('Page.stopScreencast').catch(() => {});
      }
    };
    Object.defineProperty(remove,'closed',{get:()=>cast.closed});
    return remove;
  }
  const timer = setInterval(() => { for (const entry of pages.values()) if (now() - entry.used > 30000) entry.close(); }, 10000);
  timer.unref();
  return { capture, dispatch, subscribe, close: () => { stopped = true; clearInterval(timer); for (const entry of pages.values()) entry.close(); pages.clear(); frames.clear(); casts.clear(); } };
}
