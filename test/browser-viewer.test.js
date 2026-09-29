import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native viewer emits a versioned handback only after release and omits credentials', async () => {
  const elements = new Map();
  const events = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { style: {}, clientWidth: 390, clientHeight: 520, value: '', blur() {}, focus() {}, setSelectionRange() {}, setAttribute() {}, addEventListener: (name, fn) => events.set(`${selector}:${name}`, fn) });
    return elements.get(selector);
  };
  const document = { hidden: false, querySelector: element, addEventListener() {} };
  const sent = [];
  const storage = new Map([['browser-use-controller', 'private-controller']]);
  const sessionStorage = { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  let state = { available: true, mode: 'paused', mine: true, inFlight: 0 };
  class RFB {
    viewOnly = true;
    addEventListener() {}
    disconnect() {}
  }
  const fetch = async (route) => ({ ok: true, json: async () => {
    if (route === '/browser/status') return { ready: true };
    if (route === '/browser/control/release') {
      state = { ...state, mode: 'ai', mine: false };
      return { schemaVersion: 1, mode: 'ai', epoch: 2, resumedWaitingTasks: 0, token: 'private-token', browser: { sessionKey: 'agent:main:oneclaw:direct:session_1', runId: 'run_1', targetId: 'tab_1' } };
    }
    return state;
  } });
  const source = fs.readFileSync(new URL('../src/public/browser.js', import.meta.url), 'utf8').replace(/^import [^\n]+\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('createScopedTaskViewer', 'RFB', 'document', 'sessionStorage', 'window', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'location', source)(() => ({ active: false }), RFB, document, sessionStorage, { addEventListener() {}, ReactNativeWebView: { postMessage: (message) => sent.push(JSON.parse(message)) } }, fetch, () => 1, () => 1, () => {}, { href: 'https://runtime.example/browser/', protocol: 'https:' });
  assert.equal(sent.filter(message => message.type === 'browser.control.returned').length, 0);
  assert.equal(sent.find(message => message.type === 'browser.viewer.state').mine, true);
  await events.get('#zoom:click')();
  assert.equal(element('#surface').style.width, '1280px');
  assert.equal(element('#surface').style.height, '800px');
  await events.get('#zoom:click')();
  assert.equal(element('#surface').style.width, '100%');
  await events.get('#release:click')();
  const returned = sent.filter(message => message.type === 'browser.control.returned');
  assert.equal(returned.length, 1);
  assert.equal(returned[0].browser.targetId, 'tab_1');
  assert.doesNotMatch(JSON.stringify(sent), /private-controller|private-token|ticket/);
  assert.equal(storage.has('browser-use-controller'), false);
});

test('mobile keyboard sends committed Chinese, emoji and editing keys only while owned', async () => {
  const elements = new Map(), events = new Map(), instances = [], sent = [], keys = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { style: {}, value: '', clientWidth: 390, clientHeight: 500, blur() {}, focus() {}, setSelectionRange() {}, setAttribute() {}, addEventListener: (name, fn) => events.set(`${selector}:${name}`, fn) });
    return elements.get(selector);
  };
  let state = { available: true, mode: 'ai', mine: false, inFlight: 0, epoch: 1, browserReady: true, browser: { browserTaskId: 'task1', resourceState: 'live' } };
  class RFB {
    listeners = new Map();
    constructor() { instances.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    disconnect() {}
    sendKey(key) { keys.push(key); }
  }
  const fetch = async route => ({ ok: true, json: async () => {
    if (route === '/browser/status') return { ready: true };
    if (route.startsWith('/browser/control/request')) { state = { ...state, mode: 'human', mine: true, epoch: 2 }; return { token: 'private-test-controller' }; }
    if (route === '/browser/control/release') { state = { ...state, mode: 'ai', mine: false, epoch: 3 }; return { schemaVersion: 1, epoch: 3 }; }
    return state;
  } });
  const source = fs.readFileSync(new URL('../src/public/browser.js', import.meta.url), 'utf8').replace(/^import [^\n]+\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('createScopedTaskViewer', 'RFB', 'document', 'sessionStorage', 'window', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'location', source)(() => ({ active: false }), RFB,
    { hidden: false, querySelector: element, addEventListener() {} },
    { getItem() { return null; }, setItem() {}, removeItem() {} },
    { addEventListener: (name, fn) => events.set(name, fn), ReactNativeWebView: { postMessage: value => sent.push(JSON.parse(value)) } },
    fetch, () => 1, () => 1, () => {}, { href: 'https://runtime.example/browser/', protocol: 'https:' });
  await events.get('#takeover:click')();
  assert.equal(instances.length, 1, 'unresolved native task cannot acquire writable transport');
  await events.get('oneclaw:browser-task')({ detail: { sessionId: 'session_1' } });
  await events.get('#takeover:click')();
  instances.at(-1).listeners.get('connect')();
  await events.get('#keyboard:click')();
  const input = element('#keyboard-input');
  events.get('#keyboard-input:compositionstart')(); input.value = '\u200b你'; events.get('#keyboard-input:input')();
  assert.deepEqual(keys, []);
  events.get('#keyboard-input:compositionend')(); events.get('#keyboard-input:input')();
  input.value = '\u200b😀'; events.get('#keyboard-input:input')();
  input.value = ''; events.get('#keyboard-input:input')();
  events.get('#keyboard-input:keydown')({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(keys, [0x01004f60, 0x0101f600, 0xff08, 0xff0d]);
  await events.get('#release:click')();
  input.value = 'x'; events.get('#keyboard-input:input')();
  assert.equal(keys.length, 4);
  events.get('oneclaw:browser-command')({ detail: { action: 'release' } });
  assert.equal(sent.at(-1).type, 'browser.viewer.error');
});
