import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createBrowserHandoff } from '../src/browser/handoff.js';

// Exercise the shipped plugin, including its callback into the Wrapper. A
// stubbed close-task response hides the serial-queue reentrancy deadlock.
async function setup(t, { closeFails = false, pausePreview = false, multipleTasks = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-idle-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundle = new URL('../resources/openclaw-plugin-bundle/', import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(new URL('package.json', bundle), 'utf8'));
  const spec = manifest.dependencies['@oneclaw-plugins/browser-use'];
  execFileSync('tar', ['-xzf', new URL(spec.slice('file:'.length), bundle).pathname, '-C', dir]);
  const load = (name) => import(pathToFileURL(path.join(dir, 'package', name)).href);
  const { createControl } = await load('control.mjs');
  const { createBrowserWork } = await load('work.mjs');
  const { registerBrowserUse } = await load('index.mjs');
  let time = 0, handoff;
  const control = createControl({ file: path.join(dir, 'control.json') });
  const work = control.work = createBrowserWork({ now: () => time });
  const context = { sessionKey: 'chat', runId: 'run' };
  for (const targetId of ['tab1', 'tab2']) work.complete({
    toolName: 'browser', params: { action: 'open' }, result: { details: { targetId } },
  }, context);
  work.finish({ success: true }, context);
  if (multipleTasks) {
    const other = { sessionKey: 'other', runId: 'other-run' };
    work.complete({ toolName: 'browser', params: { action: 'open' }, result: { details: { targetId: 'tab3' } } }, other);
    work.finish({ success: true }, other);
  }
  const task = work.status(context.sessionKey);
  const methods = new Map(), calls = [];
  let previewStarted, finishPreview;
  const previewEntered = new Promise(resolve => { previewStarted = resolve; });
  const previewGate = new Promise(resolve => { finishPreview = resolve; });
  let inputReady = false;
  registerBrowserUse({ on() {}, registerGatewayMethod(name, fn) { methods.set(name, fn); } }, control, {
    idleMs: 1000, preview: async () => {
      previewStarted();
      if (pausePreview) await previewGate;
      return 'data:image/jpeg;base64,YQ==';
    },
    close: async (event, ctx) => {
      let timer;
      try {
        // Same lease, callback and uncertainty behavior as internal/close;
        // shorten only the transport timeout to keep the regression fast.
        await Promise.race([
          handoff.focusTask({ runId: event.runId, toolCallId: event.toolCallId,
            sessionKey: ctx.sessionKey, targetId: event.params.targetId }, 'close'),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(
            new Error('internal close timeout'), { browserOperationUncertain: true })), 100); }),
        ]);
      } finally { clearTimeout(timer); }
    },
  });
  const rpc = { isGatewayConnected: () => true, rpcGateway: async (method, params) => {
    calls.push(params.action || params.path);
    if (methods.has(method)) {
      let result;
      await methods.get(method)({ params, respond(ok, payload, error) { result = { ok, payload, error }; } });
      return result;
    }
    if (params.method === 'DELETE') {
      if (closeFails) throw new Error('native close timeout');
      return { ok: true };
    }
    if (params.path === '/tabs') return { ok: true, payload: { running: true, tabs: [] } };
    return { ok: true, payload: { profile: 'openclaw', running: false, cdpReady: false } };
  } };
  handoff = createBrowserHandoff({ rpc, desktop: {
    status: () => ({ ready: true }), controlReady: () => inputReady,
    startControl: async () => { inputReady = true; }, stopControl: async () => { inputReady = false; },
  },
    now: () => time, idleMs: 1000 });
  t.after(() => handoff.close());
  return { handoff, control, work, task, calls, previewEntered, finishPreview,
    advance: (ms = 1001) => { time += ms; } };
}

test('idle reclamation closes task pages through the real plugin callback without pausing AI', async t => {
  const x = await setup(t);
  x.advance();
  await Promise.all([x.handoff.tick(), x.handoff.tick()]);
  assert.equal(x.control.status().mode, 'ai');
  assert.equal(x.control.status().inFlight, 0);
  assert.equal(x.calls.filter(call => call === 'close-task').length, 1);
  assert.equal(x.calls.filter(call => call === '/tabs/tab1' || call === '/tabs/tab2').length, 2);
  assert.equal(x.work.status('chat').resourceState, 'expired');
  assert.equal(x.calls.includes('/stop'), false, 'empty browser gets its own idle period');
  x.advance(30001);
  await x.handoff.tick();
  assert.equal(x.calls.filter(call => call === '/stop').length, 1);
  assert.equal(x.work.status('chat').resourceState, 'expired');
  assert.equal(x.work.frame('chat', { browserTaskId: x.task.browserTaskId }).image, 'data:image/jpeg;base64,YQ==');
  assert.equal((await x.handoff.status()).mode, 'ai');
});

test('actual uncertain native closure still retains its lease and prevents browser shutdown', async t => {
  const x = await setup(t, { closeFails: true });
  x.advance();
  await x.handoff.tick();
  assert.equal(x.calls.includes('/tabs/tab1'), true, 'native close must have actually started');
  assert.equal(x.control.status().mode, 'paused');
  assert.equal(x.control.status().inFlight, 1);
  assert.equal(x.calls.includes('/stop'), false);
  assert.throws(() => x.control.command({ action: 'recover' }), /drained/);
});

test('idle shutdown preserves final frames for every conversation after handback', async t => {
  const x = await setup(t, { multipleTasks: true });
  x.control.requireFreshSnapshots();
  x.advance();
  await x.handoff.tick();
  assert.equal(x.work.status('chat').resourceState, 'expired');
  assert.equal(x.work.status('other').resourceState, 'live');
  assert.equal(x.calls.includes('/stop'), false);
  x.advance(30001);
  await x.handoff.tick();
  assert.equal(x.work.status('other').resourceState, 'expired');
  assert.equal(x.calls.includes('/stop'), false);
  x.advance(30001);
  await x.handoff.tick();
  assert.equal(x.calls.filter(call => call === '/stop').length, 1);
  for (const session of ['chat', 'other']) assert.equal(x.work.frame(session, { browserTaskId: x.work.status(session).browserTaskId }).image, 'data:image/jpeg;base64,YQ==');
  assert.equal(x.control.status().mode, 'ai');
  assert.equal(x.control.status().inFlight, 0);
});

test('viewing during task capture prevents shared browser suspension', async t => {
  const x = await setup(t, { pausePreview: true });
  x.advance();
  const sweep = x.handoff.tick();
  await x.previewEntered;
  assert.equal((await x.handoff.status()).mode, 'ai');
  x.finishPreview();
  await sweep;
  assert.equal(x.control.status().mode, 'ai');
  assert.equal(x.calls.includes('idle-candidate'), false);
  assert.equal(x.calls.includes('/stop'), false);
});

test('takeover during task capture prevents both native closure and shared shutdown', async t => {
  const x = await setup(t, { pausePreview: true });
  x.advance();
  const sweep = x.handoff.tick();
  await x.previewEntered;
  const grant = await x.handoff.request();
  assert.equal(grant.mode, 'human');
  x.finishPreview();
  await sweep;
  assert.equal(x.control.status().mode, 'human');
  assert.equal(x.control.status().inFlight, 0);
  assert.equal(x.work.status('chat').resourceState, 'live');
  assert.equal(x.calls.some(call => call.startsWith('/tabs/')), false);
  assert.equal(x.calls.includes('/stop'), false);
});
