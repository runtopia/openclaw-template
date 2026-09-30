import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTaskPreview } from '../src/browser/preview.js';

function setup({ cdpUrl = 'http://127.0.0.1:18800', wsUrl = 'ws://127.0.0.1:18800/devtools/page/tab1', running = true } = {}) {
  const commands = [];
  let fetches = 0;
  class Socket extends EventEmitter {
    constructor(url) { super(); assert.equal(url, wsUrl); queueMicrotask(() => this.emit('open')); }
    send(raw) {
      const command = JSON.parse(raw); commands.push(command);
      queueMicrotask(() => this.emit('message', JSON.stringify({ id: command.id, result: command.id === 1
        ? { cssVisualViewport: { clientWidth: 1280, clientHeight: 800, pageX: 0, pageY: 20 } }
        : { data: 'ZnJhbWU=' } })));
    }
    close() {} terminate() {}
  }
  const capture = createTaskPreview({
    rpc: { async rpcGateway(method, params) { assert.equal(method, 'browser.request'); assert.equal(params.method, 'GET'); assert.equal(params.path, '/'); return { ok: true, payload: { running, cdpReady: true, cdpUrl } }; } },
    fetchImpl: async url => { fetches++; assert.equal(url.href, 'http://127.0.0.1:18800/json/list'); return { ok: true, json: async () => [{ id: 'tab1', type: 'page', webSocketDebuggerUrl: wsUrl }] }; },
    WebSocketImpl: Socket,
  });
  return { capture, commands, fetches: () => fetches };
}

test('preview captures only the requested tab without mutating its viewport, input or focus', async () => {
  const f = setup();
  assert.deepEqual(await f.capture('tab1'), { image: 'data:image/jpeg;base64,ZnJhbWU=' });
  assert.deepEqual(f.commands.map(command => command.method), ['Page.getLayoutMetrics', 'Page.captureScreenshot']);
  assert.equal(f.commands[1].params.clip, undefined, 'CDP clip re-emulates the visible renderer');
  assert.equal(f.commands[1].params.captureBeyondViewport, false);
  await assert.rejects(f.capture('other'), /closed/);
});

test('preview never starts a stopped browser or follows a remote CDP destination', async () => {
  for (const options of [{ running: false }, { cdpUrl: 'http://198.18.0.1:18800' }, { cdpUrl: 'https://evil.example' }, { wsUrl: 'ws://127.0.0.1:18801/devtools/page/tab1' }, { wsUrl: 'ws://127.0.0.1:18800/devtools/page/tab2' }]) {
    const f = setup(options); await assert.rejects(f.capture('tab1'));
    assert.equal(f.commands.length, 0);
  }
});
