import { WebSocketServer } from 'ws';

// Read-only media channel. Each frame is [uint32 metadata length][JSON][JPEG].
// Control and input remain on the authenticated task authority, never here.
export function createTaskMedia({ readFrame }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const cache = new Map();
  let stopped = false;
  const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value);
  function accept(req, socket, head) {
    const query = new URL(req.url, 'http://internal').searchParams;
    const browserTaskId = query.get('browserTaskId');
    const sessionId = query.get('sessionId'), sessionKey = query.get('sessionKey');
    if (stopped || !readFrame || server.clients.size >= 16 || !/^[A-Za-z0-9_-]{1,128}$/.test(browserTaskId || '')
        || !(sessionId ? /^session_[A-Za-z0-9_-]{1,128}$/.test(sessionId) && !sessionKey : valid(sessionKey))) {
      socket.end('HTTP/1.1 400 Invalid task stream\r\nConnection: close\r\n\r\n'); return;
    }
    const fields = { browserTaskId, viewer: true, ...(sessionId ? { nativeSessionId: sessionId } : { sessionKey }) };
    const key = JSON.stringify(fields);
    server.handleUpgrade(req, socket, head, ws => {
      let timer, closed = false, failures = 0;
      const stop = () => { closed = true; clearTimeout(timer); };
      ws.on('close', stop); ws.on('error', stop);
      ws.on('message', () => ws.close(1008, 'Read-only stream'));
      async function tick() {
        if (closed || stopped || ws.readyState !== 1) return;
        try {
          if (ws.bufferedAmount < 1024 * 1024) {
            let sample = cache.get(key);
            if (!sample || Date.now() - sample.at >= 200) {
              sample = { at: Date.now(), promise: Promise.resolve().then(() => readFrame(fields)) };
              cache.set(key, sample);
              if (cache.size > 64) cache.delete(cache.keys().next().value);
            }
            const frame = await sample.promise;
            if (closed || ws.readyState !== 1) return;
            if (frame.browserTaskId !== browserTaskId || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(frame.image || '')) throw new Error('Frame unavailable');
            const { image, ...metadata } = frame;
            const json = Buffer.from(JSON.stringify(metadata));
            const bytes = Buffer.from(image.slice(image.indexOf(',') + 1), 'base64');
            if (json.length > 8192 || bytes.length > 700000) throw new Error('Frame too large');
            const header = Buffer.alloc(4); header.writeUInt32BE(json.length);
            ws.send(Buffer.concat([header, json, bytes]));
            failures = 0;
          }
        } catch {
          if (++failures >= 5) { ws.close(1013, 'Task preview unavailable'); return; }
        }
        if (!closed) timer = setTimeout(tick, 200);
      }
      void tick();
    });
  }
  return { accept, close: () => { stopped = true; for (const ws of server.clients) ws.terminate(); server.close(); cache.clear(); } };
}
