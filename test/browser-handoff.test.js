import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createBrowserHandoff } from '../src/browser/handoff.js';

function setup(t) {
  let mode = 'ai', inFlight = 0, ready = false, connected = true, time = 0;
  const history = [];
  const desktop = {
    status: () => ({ ready: true }), controlReady: () => ready,
    startControl: async () => { history.push('input-on'); ready = true; },
    stopControl: async () => { history.push('input-off'); ready = false; },
  };
  const rpc = {
    isGatewayConnected: () => connected,
    rpcGateway: async (_method, params) => {
      history.push(params.action);
      if (!connected) throw new Error('offline');
      if (params.action === 'request') { if (mode !== 'ai') throw new Error('reserved'); mode = 'waiting'; }
      if (params.action === 'grant' || params.action === 'resume') mode = 'human';
      if (params.action === 'pause') mode = 'paused';
      if (params.action === 'release' || params.action === 'recover') { assert.equal(ready, false, 'input must stop before AI release'); mode = 'ai'; }
      if (params.action === 'admin-begin') { if (mode !== 'ai') throw new Error('reserved'); inFlight++; }
      if (params.action === 'admin-end') inFlight--;
      return { ok: true, payload: { mode, inFlight } };
    },
  };
  const h = createBrowserHandoff({ rpc, desktop, now: () => time, heartbeatMs: 100 });
  t.after(() => h.close());
  return { h, history, desktop, setActive: (n) => { inFlight = n; }, disconnect: () => { connected = false; }, expire: () => { time = 101; } };
}

test('waits for drain before enabling input, refuses second controller, revokes before handback', async (t) => {
  const x = setup(t);
  x.setActive(1);
  const grant = await x.h.request();
  assert.equal(grant.mode, 'waiting');
  assert.equal(x.desktop.controlReady(), false);
  await assert.rejects(x.h.request(), /reserved/);
  x.setActive(0);
  assert.equal((await x.h.status(grant.token)).mode, 'human');
  assert.equal(x.desktop.controlReady(), true);
  await assert.rejects(x.h.release('wrong'), /does not own/);
  await x.h.release(grant.token);
  assert.ok(x.history.lastIndexOf('input-off') < x.history.lastIndexOf('release'));
});
test('only one writable connection; disconnect stays paused and supports explicit resume', async (t) => {
  const x = setup(t);
  const grant = await x.h.request();
  const client = new EventEmitter(); client.terminate = () => client.emit('close');
  await x.h.connect(grant.token, () => client);
  await assert.rejects(x.h.connect(grant.token, () => client), /already connected/);
  client.emit('close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await x.h.status(grant.token)).mode, 'paused');
  assert.equal(x.desktop.controlReady(), false);
  await x.h.resume(grant.token);
  assert.equal(x.desktop.controlReady(), true);
});
test('control-plane loss or expired owner heartbeat closes writable transport', async (t) => {
  const x = setup(t);
  await x.h.request(); x.expire(); await x.h.tick();
  assert.equal(x.desktop.controlReady(), false);
  assert.equal((await x.h.status()).mode, 'paused');
  await x.h.recover(); await x.h.request(); x.disconnect(); await x.h.tick();
  assert.equal(x.desktop.controlReady(), false);
});
test('wrapper start is tracked until completion while takeover is waiting', async (t) => {
  const x = setup(t);
  let finish;
  const operation = x.h.runNative(() => new Promise((resolve) => { finish = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const grant = await x.h.request();
  assert.equal(grant.inFlight, 1);
  assert.equal(x.desktop.controlReady(), false);
  finish(); await operation;
  assert.equal((await x.h.status(grant.token)).mode, 'human');
});

test('failed input shutdown never grants AI control', async (t) => {
  const x = setup(t);
  const grant = await x.h.request();
  const stop = x.desktop.stopControl;
  x.desktop.stopControl = async () => { throw new Error('process still alive'); };
  await assert.rejects(x.h.release(grant.token), /still alive/);
  assert.equal(x.history.includes('release'), false);
  x.desktop.stopControl = stop;
});
