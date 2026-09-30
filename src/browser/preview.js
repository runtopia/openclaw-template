import { WebSocket } from 'ws';

function localEndpoint(value, protocol) {
  const url = new URL(value);
  if (!protocol.includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('Invalid managed browser endpoint');
  return url;
}

export function createTaskPreview({ rpc, fetchImpl = fetch, WebSocketImpl = WebSocket }) {
  return async (targetId, { viewer = false } = {}) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(targetId)) throw new Error('Invalid browser target');
    const status = await rpc.rpcGateway('browser.request', { method: 'GET', path: '/', query: { profile: 'openclaw' } }, 3000);
    if (!status.ok || status.payload?.running !== true || status.payload?.cdpReady !== true) throw new Error('Browser is not ready');
    const endpoint = localEndpoint(status.payload.cdpUrl, ['http:']);
    const list = await fetchImpl(new URL('/json/list', endpoint), { redirect: 'error', signal: AbortSignal.timeout(2000) });
    if (!list.ok) throw new Error('Browser is unavailable');
    const tabs = await list.json();
    const tab = Array.isArray(tabs) && tabs.find(item => item.id === targetId && item.type === 'page');
    if (!tab) throw new Error('Browser target closed');
    const socketUrl = localEndpoint(tab.webSocketDebuggerUrl, ['ws:']);
    if (socketUrl.hostname !== endpoint.hostname || socketUrl.port !== endpoint.port || socketUrl.pathname !== `/devtools/page/${targetId}`) throw new Error('Invalid browser target endpoint');
    return capture(socketUrl.href, WebSocketImpl, viewer);
  };
}

function capture(url, WebSocketImpl, viewer) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url, { maxPayload: 1024 * 1024 });
    let settled = false;
    function finish(error, image) {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.close();
      if (error) reject(error); else resolve({ image });
    }
    const timer = setTimeout(() => { finish(new Error('Preview timeout')); socket.terminate(); }, 3000);
    socket.on('error', () => finish(new Error('Preview connection failed')));
    socket.on('close', () => finish(new Error('Browser target closed')));
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'Page.getLayoutMetrics' })));
    socket.on('message', data => {
      try {
        const message = JSON.parse(String(data));
        if (message.id === 1) {
          const viewport = message.result?.cssVisualViewport;
          if (message.error || !viewport || !Number.isFinite(viewport.clientWidth) || !Number.isFinite(viewport.clientHeight) || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) throw new Error('Preview viewport unavailable');
          socket.send(JSON.stringify({ id: 2, method: 'Page.captureScreenshot', params: {
            format: 'jpeg', quality: viewer ? 85 : 65, captureBeyondViewport: false, fromSurface: true,
          } }));
        } else if (message.id === 2) {
          const image = message.result?.data;
          if (message.error || typeof image !== 'string' || image.length > 680000 || !/^[A-Za-z0-9+/=]+$/.test(image)) throw new Error('Preview capture failed');
          finish(null, `data:image/jpeg;base64,${image}`);
        }
      } catch (error) { finish(error); }
    });
  });
}
