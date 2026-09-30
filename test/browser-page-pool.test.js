import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserPagePool } from '../src/browser/page-pool.js';

function fixture(t, { oversizedAboveQuality = 100, navigateOnFocus = false } = {}) {
  let sockets = 0, loader = 'doc-1', scroll = 0, dropInput = false;
  const commands = [];
  let transport;
  class Socket extends EventEmitter {
    constructor() { super(); transport=this; sockets++; queueMicrotask(() => this.emit('open')); }
    send(raw) {
      const { id, method, params } = JSON.parse(raw); commands.push({ method, params });
      if (navigateOnFocus && method === 'Page.bringToFront') loader = 'focused-document';
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
  return { pool, commands, emit: (method,params) => transport.emit('message',JSON.stringify({method,params})), sockets: () => sockets, navigate: () => { loader = 'doc-2'; }, scroll: () => { scroll = 500; }, disconnectInput: () => { dropInput = true; } };
}

test('read-only background capture never focuses; admitted input activates only its target and revalidates the document', async t => {
  const f = fixture(t);
  await f.pool.subscribe('a', () => {});
  f.emit('Page.screencastVisibilityChanged', {visible:false});
  const frame = await f.pool.capture('a', {viewer:true});
  assert.equal(f.commands.some(c=>c.method==='Page.bringToFront'),false);
  await assert.rejects(f.pool.dispatch('a',{type:'text',text:'denied'},{protocolVersion:2,frameToken:'unknown'}),/Stale/);
  assert.equal(f.commands.some(c=>c.method==='Page.bringToFront'),false);
  await f.pool.dispatch('a',{type:'text',text:'owned'},{protocolVersion:2,frameToken:frame.frameToken});
  assert.ok(f.commands.findIndex(c=>c.method==='Page.bringToFront')<f.commands.findIndex(c=>c.method==='Input.insertText'));
  const changed = fixture(t,{navigateOnFocus:true});
  await changed.pool.subscribe('a',()=>{});
  const old = await changed.pool.capture('a');
  await assert.rejects(changed.pool.dispatch('a',{type:'text',text:'wrong-document'},{protocolVersion:2,frameToken:old.frameToken}),/Stale/);
  assert.equal(changed.commands.some(c=>c.method.startsWith('Input.')),false);
});

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

 test('screencast shares one renderer stream, acknowledges frames and never emulates a viewport', async t => {
  const f=fixture(t), framesA=[],framesB=[];
  const removeA=await f.pool.subscribe('a',frame=>framesA.push(frame));
  const removeB=await f.pool.subscribe('a',frame=>framesB.push(frame));
  assert.equal(f.commands.filter(c=>c.method==='Page.startScreencast').length,1);
  f.emit('Page.screencastFrame',{sessionId:1,data:'aW1hZ2U=',metadata:{scrollOffsetY:0}});
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(framesA.length,1);assert.equal(framesB.length,1);
  assert.equal(f.commands.filter(c=>c.method==='Page.captureScreenshot').length,0);
  assert.equal(f.commands.filter(c=>c.method==='Page.screencastFrameAck').length,1);
  assert.equal((await f.pool.capture('a',{viewer:true})).frameToken,framesA[0].frameToken);
  await f.pool.dispatch('a',{type:'text',text:'once'},{protocolVersion:2,frameToken:framesA[0].frameToken});
  removeA();assert.equal(f.commands.some(c=>c.method==='Page.stopScreencast'),false);
  removeB();assert.equal(f.commands.filter(c=>c.method==='Page.stopScreencast').length,1);
  assert.equal(f.commands.some(c=>c.method.startsWith('Emulation.') || c.method==='Page.bringToFront'),false);
 });
 test('continuous scrolling and typing tolerate owned viewport scroll, while new click and navigation remain fenced', async t => {
  const f=fixture(t), frame=await f.pool.capture('a');f.scroll();
  await f.pool.dispatch('a',{type:'scroll',x:.5,y:.5,deltaY:100},{protocolVersion:2,frameToken:frame.frameToken});
  await f.pool.dispatch('a',{type:'key',key:'a',modifiers:2},{protocolVersion:2,frameToken:frame.frameToken});
  const key=f.commands.find(c=>c.method==='Input.dispatchKeyEvent');assert.equal(key.params.modifiers,2);assert.equal(key.params.code,'KeyA');
  await assert.rejects(f.pool.dispatch('a',{type:'down',x:.5,y:.5},{protocolVersion:2,frameToken:frame.frameToken}),/Stale/);
  f.navigate();await assert.rejects(f.pool.dispatch('a',{type:'text',text:'wrong-document'},{protocolVersion:2,frameToken:frame.frameToken}),/Stale/);
 });
