import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createScopedTaskViewer } from '../src/public/browser-task.js';

function setup(t) {
  const globals = ['document', 'window', 'sessionStorage', 'fetch', 'Image', 'setTimeout', 'clearTimeout'];
  const originals = Object.fromEntries(globals.map(k => [k, globalThis[k]]));
  const elements = new Map(), requests = [], timers = new Map();
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms !== 1000) return originals.setTimeout(fn, ms, ...args);
    const id = {}; timers.set(id, fn); return id;
  };
  globalThis.clearTimeout = id => timers.has(id) ? timers.delete(id) : originals.clearTimeout(id);
  const element = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, width: 720, height: 450,
      context: { clearRect() {}, drawImage() {} }, getContext() { return this.context; }, listeners: {}, children: [],
      addEventListener(name, callback) { this.listeners[name] = callback; },
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); }, setAttribute() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 720, height: 450 }) });
    return elements.get(id);
  };
  globalThis.document = { hidden: false, querySelector: element, createElement: () => element(Symbol()), addEventListener() {} };
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
  const poll = async () => { const [id, fn] = timers.entries().next().value; timers.delete(id); await fn(); await flush(); };
  return { viewer, requests, tasks, elements, flush, poll, intercept: fn => { intercept = fn; } };
}

test('new frames preserve the existing surface and task tab buttons instead of clearing or replacing them', async t => {
  const x = setup(t), surface = x.elements.get('#task-canvas');
  let widthWrites = 0, heightWrites = 0, draws = 0, frameNumber = 0;
  Object.defineProperty(surface, 'width', { get: () => 720, set: () => { widthWrites++; } });
  Object.defineProperty(surface, 'height', { get: () => 450, set: () => { heightWrites++; } });
  surface.context.drawImage = () => { draws++; };
  x.tasks.a.pages = [{ targetId: 'tab-a', displayUrl: 'https://example.com' }, { targetId: 'tab-a2', displayUrl: 'https://www.baidu.com' }];
  x.intercept(url => url.startsWith('/browser/task-preview') ? { ...x.tasks.a, image: 'data:image/jpeg;base64,' + (++frameNumber === 1 ? 'YQ==' : 'Yg==') } : undefined);
  await x.viewer.open({ sessionId: 'a', toolCallId: 'a' }); await x.flush();
  const buttons = [...x.elements.get('#task-tabs').children];
  await x.poll();
  assert.equal(draws, 2, 'the updated picture is painted');
  assert.equal(widthWrites + heightWrites, 0, 'same-size frames must not reset the canvas');
  assert.equal(x.elements.get('#task-tabs').children[0], buttons[0], 'focused tab controls survive frame updates');
  assert.equal(x.elements.get('#task-tabs').children[1], buttons[1]);
});

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

test('late old-task page selection cannot replace a newly selected conversation', async t => {
  const x = setup(t);
  x.tasks.a.pages = [{ targetId: 'tab-a' }, { targetId: 'popup-a' }];
  await x.viewer.open({ sessionId: 'a', toolCallId: 'a' }); await x.flush(); await x.viewer.takeover();
  let complete;
  x.intercept((_url, body) => body?.action === 'select'
    ? new Promise(resolve => { complete = resolve; }) : undefined);
  const selecting = x.elements.get('#task-tabs').children[1].listeners.click(); await x.flush();
  await x.viewer.open({ sessionId: 'b', toolCallId: 'b' }); await x.flush(); await x.viewer.takeover();
  complete({ mode: 'human', mine: true, browser: { ...x.tasks.a, targetId: 'popup-a' } }); await selecting;
  assert.equal(x.viewer.canType, true);
  x.viewer.send({ type: 'text', text: 'new task' }); await x.flush();
  assert.equal(x.requests.at(-1).browserTaskId, 'task-b');
});

test('late old-task takeover failure cannot disable the new task', async t => {
  const x = setup(t);
  await x.viewer.open({ sessionId: 'a', toolCallId: 'a' }); await x.flush();
  let fail;
  x.intercept((_url, body) => body?.action === 'request' && body.sessionId === 'a'
    ? new Promise((_, reject) => { fail = reject; }) : undefined);
  const takeover = x.viewer.takeover(); await x.flush();
  await x.viewer.open({ sessionId: 'b', toolCallId: 'b' }); await x.flush(); await x.viewer.takeover();
  fail(new Error('old takeover lost')); await takeover;
  assert.equal(x.viewer.canType, true);
});

test('a transient preview failure blocks stale-frame input and resumes after a valid frame', async t => {
  const x = setup(t);
  await x.viewer.open({ sessionId: 'a', toolCallId: 'a' }); await x.flush(); await x.viewer.takeover();
  assert.equal(x.viewer.canType, true);
  x.intercept(url => { if (url.startsWith('/browser/task-preview')) throw new Error('Preview busy'); });
  await x.poll();
  assert.equal(x.viewer.canType, false, 'stale image cannot receive input');
  x.intercept(() => undefined);
  await x.poll();
  assert.equal(x.viewer.canType, true, 'read-only preview failure does not discard manual control intent');
});
