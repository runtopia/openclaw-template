import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createScopedTaskViewer } from '../src/public/browser-task.js';

function setup(t) {
  const globals = ['document', 'window', 'sessionStorage', 'fetch', 'Image'];
  const originals = Object.fromEntries(globals.map(k => [k, globalThis[k]]));
  const elements = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, width: 720, height: 450,
      getContext: () => ({ clearRect() {}, drawImage() {} }), addEventListener() {},
      replaceChildren() {}, append() {}, setAttribute() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 450 }) });
    return elements.get(id);
  };
  globalThis.document = { hidden: false, querySelector: element, addEventListener() {} };
  globalThis.window = { addEventListener() {}, confirm: () => true };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.Image = class { naturalWidth = 720; naturalHeight = 450; decode() { return Promise.resolve(); } };
  const tasks = Object.fromEntries(['a', 'b'].map(id => [id, { browserTaskId: 'task-' + id,
    targetId: 'tab-' + id, generation: 'g', sessionKey: id, resourceState: 'live', phase: 'completed' }]));
  const modes = { a: 'ai', b: 'ai' };
  let intercept = async () => {};
  globalThis.fetch = async (url, options) => {
    const body = options ? JSON.parse(options.body) : null;
    if (body) requests.push(body);
    const held = await intercept(url, body);
    if (held) return { ok: true, json: async () => held };
    let result;
    if (url === '/browser/task-resolve') result = { browser: tasks[body.sessionId] };
    else if (url.startsWith('/browser/task-preview')) {
      const id = new URL(url, 'http://test').searchParams.get('sessionId');
      result = { ...tasks[id], image: 'data:image/jpeg;base64,YQ==' };
    } else {
      const id = body.sessionId;
      if (body.action === 'request') modes[id] = 'human';
      if (body.action === 'pause') modes[id] = 'paused';
      result = { browser: tasks[id], mode: modes[id], mine: modes[id] !== 'ai', inFlight: 0, epoch: 1,
        ...(body.action === 'request' ? { token: id.repeat(64) } : {}) };
    }
    return { ok: true, json: async () => result };
  };
  const viewer = createScopedTaskViewer({ postNative() {}, stopDesktop() {} });
  t.after(() => { viewer.dispose(); for (const key of globals) {
    if (originals[key] === undefined) delete globalThis[key]; else globalThis[key] = originals[key];
  } });
  const flush = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
  return { viewer, requests, tasks, flush, intercept: fn => { intercept = fn; } };
}

test('late old-task management response cannot replace the selected task', async t => {
  const x = setup(t);
  await x.viewer.open({ sessionId: 'a', toolCallId: 'a' }); await x.flush();
  let complete;
  x.intercept((url, body) => url === '/browser/task-manage'
    ? new Promise(resolve => { complete = resolve; }) : undefined);
  const closing = x.viewer.manage('close-task'); await x.flush();
  await x.viewer.open({ sessionId: 'b', toolCallId: 'b' }); await x.flush();
  complete({ browser: { ...x.tasks.a, resourceState: 'expired' } }); await closing;
  await x.viewer.takeover();
  assert.equal(x.requests.at(-1).browserTaskId, 'task-b');
  assert.equal(x.viewer.canType, true);
});

test('old-task input failure cannot disable newly selected task input', async t => {
  const x = setup(t);
  await x.viewer.open({ sessionId: 'a', toolCallId: 'a' }); await x.flush(); await x.viewer.takeover();
  let fail;
  x.intercept((url, body) => body?.action === 'input' && body.sessionId === 'a'
    ? new Promise((_, reject) => { fail = reject; }) : undefined);
  x.viewer.send({ type: 'text', text: 'old' }); await x.flush();
  await x.viewer.open({ sessionId: 'b', toolCallId: 'b' }); await x.flush(); await x.viewer.takeover();
  fail(new Error('old transport lost')); await x.flush();
  assert.equal(x.viewer.canType, true);
  x.viewer.send({ type: 'text', text: 'new' }); await x.flush();
  assert.equal(x.requests.at(-1).browserTaskId, 'task-b');
});
