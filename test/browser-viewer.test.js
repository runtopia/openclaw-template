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

test('native keyboard sends committed text to the scoped task without a writable desktop', async () => {
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
  const scoped = { active: false, canType: false, async open() { this.active = true; }, async takeover() { this.canType = true; }, async action() { this.canType = false; }, send(event) { keys.push(event); return true; } };
  await new AsyncFunction('createScopedTaskViewer', 'RFB', 'document', 'sessionStorage', 'window', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'location', source)(() => scoped, RFB,
    { hidden: false, querySelector: element, addEventListener() {} },
    { getItem() { return null; }, setItem() {}, removeItem() {} },
    { addEventListener: (name, fn) => events.set(name, fn), ReactNativeWebView: { postMessage: value => sent.push(JSON.parse(value)) } },
    fetch, () => 1, () => 1, () => {}, { href: 'https://runtime.example/browser/', protocol: 'https:' });
  await events.get('#takeover:click')();
  assert.equal(instances.length, 1, 'unresolved native task cannot acquire writable transport');
  await events.get('oneclaw:browser-task')({ detail: { sessionId: 'session_1' } });
  await events.get('#takeover:click')();
  assert.equal(instances.length, 1, 'task control does not create a writable VNC connection');
  await events.get('#keyboard:click')();
  const input = element('#keyboard-input');
  events.get('#keyboard-input:compositionstart')(); input.value = '\u200b你'; events.get('#keyboard-input:input')();
  assert.deepEqual(keys, []);
  events.get('#keyboard-input:compositionend')(); events.get('#keyboard-input:input')();
  input.value = '\u200b😀'; events.get('#keyboard-input:input')();
  input.value = ''; events.get('#keyboard-input:input')();
  events.get('#keyboard-input:keydown')({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(keys, [{ type: 'text', text: '你' }, { type: 'text', text: '😀' }, { type: 'key', key: 'Backspace' }, { type: 'key', key: 'Enter' }]);
  await events.get('#release:click')();
  input.value = 'x'; events.get('#keyboard-input:input')();
  assert.equal(keys.length, 4);
  assert.equal(scoped.canType, false);
});

test('native task selection delivered before module startup never opens the shared desktop', async () => {
  const events = new Map(), elements = new Map(), requests = [], opened = [];
  const detail = { sessionId: 'session_test', toolCallId: 'exact-call' };
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { style: {}, addEventListener() {}, blur() {}, setAttribute() {} });
    return elements.get(selector);
  };
  const scoped = { active: false, async open(value) { this.active = true; opened.push(value); } };
  const window = { __oneclawBrowserTask: detail, addEventListener: (name, fn) => events.set(name, fn), dispatchEvent: event => events.get(event.type)?.(event) };
  const source = fs.readFileSync(new URL('../src/public/browser.js', import.meta.url), 'utf8').replace(/^import [^\n]+\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('createScopedTaskViewer', 'RFB', 'document', 'sessionStorage', 'window', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'location', 'CustomEvent', source)(
    () => scoped, class { constructor() { throw new Error('Shared desktop must not open'); } },
    { hidden: false, querySelector: element, addEventListener() {} }, { getItem: () => null }, window,
    async route => { requests.push(route); throw new Error('Unexpected shared request'); }, () => 1, () => 1, () => {},
    { href: 'https://runtime.example/browser/' }, class { constructor(type, options) { this.type = type; this.detail = options.detail; } });
  assert.deepEqual(opened, [detail]);
  assert.deepEqual(requests, []);
});

test('shared task boot including an invalid selector never connects to the global desktop', async () => {
  const source = fs.readFileSync(new URL('../src/public/browser.js', import.meta.url), 'utf8').replace(/^import [^\n]+\n/gm, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const search of ['?sessionKey=agent%3Amain%3Adashboard%3Aowner&browserTaskId=task-1','?browserTaskId=missing']) {
    const events = new Map(), element=selector=>({style:{},addEventListener:(name,fn)=>events.set(`${selector}:${name}`,fn)});
    const scoped={active:false,async open(detail){this.active=true;this.selection=detail;}};
    let desktops=0, reads=0;
    class RFB {constructor(){desktops++;}}
    await new AsyncFunction('createScopedTaskViewer','RFB','document','sessionStorage','window','fetch','setInterval','setTimeout','clearTimeout','location',source)(
      ()=>scoped,RFB,{querySelector:element,addEventListener(){},hidden:false},{getItem:()=>null}, {addEventListener(){}},
      async()=>{reads++;throw new Error('must not access global state');},()=>1,()=>1,()=>{}, {href:'https://runtime.example/browser/'+search,protocol:'https:',search});
    assert.equal(desktops,0);assert.equal(reads,0);assert.equal(scoped.active,true);
    assert.equal(scoped.selection.browserTaskId, search.includes('task-1')?'task-1':'missing');
    assert.equal(scoped.selection.sessionKey, search.includes('task-1')?'agent:main:dashboard:owner':'invalid');
  }
});
