import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserPagePool } from '../src/browser/page-pool.js';

function fixture(t, { oversizedAboveQuality = 100 } = {}) {
  let sockets = 0, loader = 'doc-1', scroll = 0, dropInput = false;
  const commands = [];
  class Socket extends EventEmitter {
    constructor() { super(); sockets++; queueMicrotask(() => this.emit('open')); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw); commands.push({ method, params });
      if (dropInput && method.startsWith('Input.')) { queueMicrotask(() => this.emit('close')); return; }
      const result = method === 'Page.getLayoutMetrics' ? { cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: scroll } }
        : method === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'root', loaderId: loader } } }
        : method === 'Page.captureScreenshot' ? { data: params.quality > oversizedAboveQuality ? 'A'.repeat(680004) : 'aW1hZ2U=' } : { targetInfos: [] };
      queueMicrotask(() => this.emit('message', JSON.stringify({ id, result })));
    }
    terminate() {}
  }
  const pool = createBrowserPagePool({
    rpc: { rpcGateway: async () => ({ ok: true, payload: { running: true, cdpReady: true, cdpUrl: 'http://127.0.0.1:18800' } }) },
    fetchImpl: async () => ({ ok: true, json: async () => [{ id: 'a', type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/page/a' }] }),
    WebSocketImpl: Socket,
  });
  t.after(pool.close);
  return { pool, commands, sockets: () => sockets, navigate: () => { loader = 'doc-2'; }, scroll: () => { scroll = 500; }, disconnectInput: () => { dropInput = true; } };
}

test('captures and inputs reuse a page connection and reject other page frames', async t => {
  const f = fixture(t);
  const frame = await f.pool.capture('a');
  await f.pool.capture('a', { viewer: true });
  await f.pool.dispatch('a', { type: 'text', text: '中文🙂' }, { protocolVersion: 2, frameToken: frame.frameToken });
  assert.equal(f.sockets(), 1);
  assert.equal(f.commands.filter(c => c.method === 'Input.insertText').length, 1);
  await assert.rejects(f.pool.dispatch('a', { type: 'text', text: 'wrong' }, { protocolVersion: 2, frameToken: 'unknown' }), /Stale/);
  await assert.rejects(f.pool.dispatch('a', { type: 'text', text: 'before-grant' }, { protocolVersion: 2, frameToken: frame.frameToken, minFrameAt: Date.now() + 1 }), /Stale/);
  assert.equal(f.commands.filter(c => c.method === 'Input.insertText').length, 1);
  await assert.rejects(f.pool.capture('b'), /closed/);
});

test('same-target navigation and scrolling invalidate the old input frame', async t => {
  const f = fixture(t);
  const old = await f.pool.capture('a');
  f.navigate();
  await assert.rejects(f.pool.dispatch('a', { type: 'down', x: .5, y: .5 }, { protocolVersion: 2, frameToken: old.frameToken }), /Stale/);
  const current = await f.pool.capture('a');
  f.scroll();
  await assert.rejects(f.pool.dispatch('a', { type: 'down', x: .5, y: .5 }, { protocolVersion: 2, frameToken: current.frameToken }), /Stale/);
  assert.equal(f.commands.some(c => c.method.startsWith('Input.')), false);
});

test('a disconnected sent input remains uncertain and is never retried', async t => {
  const f = fixture(t);
  const frame = await f.pool.capture('a');
  f.disconnectInput();
  await assert.rejects(f.pool.dispatch('a', { type: 'text', text: 'once' }, { protocolVersion: 2, frameToken: frame.frameToken }), error => error.browserOperationUncertain === true);
  assert.equal(f.commands.filter(c => c.method === 'Input.insertText').length, 1);
});

test('concurrent thumbnail and viewer capture never resize or re-emulate the headed browser', async t => {
  const f = fixture(t);
  const frames = await Promise.all([f.pool.capture('a'), f.pool.capture('a', { viewer: true })]);
  assert.equal(frames.length, 2);
  for (const command of f.commands.filter(c => c.method === 'Page.captureScreenshot')) {
    assert.equal(command.params.clip, undefined, 'clip temporarily changes renderer geometry and disrupts desktop streaming');
    assert.equal(command.params.captureBeyondViewport, false);
  }
  assert.equal(f.commands.some(c => c.method.startsWith('Emulation.') || c.method === 'Browser.setWindowBounds'), false);
  await f.pool.dispatch('a', { type: 'down', x: .75, y: .5 }, { protocolVersion: 2, frameToken: frames[0].frameToken });
  const input = f.commands.find(c => c.method === 'Input.dispatchMouseEvent');
  assert.equal(input.params.x, 960);
  assert.equal(input.params.y, 400);
});

test('large frames lower JPEG quality without shrinking the page and remain bounded', async t => {
  const f = fixture(t, { oversizedAboveQuality: 40 });
  const frame = await f.pool.capture('a', { viewer: true });
  assert.ok(frame.frameToken);
  assert.deepEqual(f.commands.filter(c => c.method === 'Page.captureScreenshot').map(c => c.params.quality), [80, 60, 40]);
  const tooLarge = fixture(t, { oversizedAboveQuality: 0 });
  await assert.rejects(tooLarge.pool.capture('a', { viewer: true }), /Invalid browser frame/);
  assert.equal(tooLarge.commands.filter(c => c.method === 'Page.captureScreenshot').length, 3);
});
