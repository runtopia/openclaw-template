import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHandoff } from '../src/browser/handoff.js';

function setup(t) {
  let time = 0, candidate = true, failStop = false, mode = 'ai', unowned = false;
  const calls = [];
  const rpc = { isGatewayConnected: () => true, rpcGateway: async (method, params) => {
    calls.push(params.action || params.path);
    if (method === 'browser.request') {
      if (params.path === '/tabs') return { ok: true, payload: { running: true, tabs: [{ type: 'page', targetId: 'tab1', url: 'https://example.com' }, ...(unowned ? [{ type: 'page', targetId: 'other', url: 'https://user.example/form' }] : [])] } };
      if (params.path === '/stop') { assert.equal(calls.includes('idle-begin'), true); if (failStop) throw new Error('timeout'); }
      return { ok: true, payload: {} };
    }
    if (params.action === 'idle-candidate') return { ok: true, payload: { candidate: candidate && mode === 'ai' ? { revision: 1, targetIds: ['tab1'] } : null } };
    if (params.action === 'idle-end') assert.equal(params.stopped, true);
    if (params.action === 'idle-uncertain') mode = 'paused';
    return { ok: true, payload: { starts: [], mode, inFlight: 0 } };
  } };
  const h = createBrowserHandoff({ rpc, desktop: { controlReady: () => false, stopControl: async () => {} }, now: () => time, idleMs: 1000 });
  t.after(() => h.close());
  return { h, calls, advance: (ms) => { time += ms; }, unowned: () => { unowned = true; }, fail: () => { failStop = true; }, retain: () => { candidate = false; }, mode: () => mode };
}
test('idle suspension respects viewing activity and only stops known completed task pages', async (t) => {
  const x = setup(t);
  x.advance(999); await x.h.tick(); assert.equal(x.calls.includes('/stop'), false);
  await x.h.status(); x.advance(999); await x.h.tick(); assert.equal(x.calls.includes('/stop'), false);
  x.advance(2); await x.h.tick(); assert.equal(x.calls.includes('/stop'), true); assert.equal(x.calls.includes('idle-end'), true);
});
test('unmanaged pages and retained human work prevent idle suspension', async (t) => {
  const x = setup(t); x.unowned(); x.advance(1001); await x.h.tick(); assert.equal(x.calls.includes('/stop'), false);
  const y = setup(t); y.retain(); y.advance(1001); await y.h.tick(); assert.equal(y.calls.includes('/stop'), false);
});
test('uncertain idle shutdown stays paused without falsely completing its lease', async (t) => {
  const x = setup(t); x.fail(); x.advance(1001); await x.h.tick();
  assert.equal(x.mode(), 'paused'); assert.equal(x.calls.includes('idle-end'), false);
});
