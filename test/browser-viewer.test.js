import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('native viewer emits a versioned handback only after release and omits credentials', async () => {
  const elements = new Map();
  const events = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, { addEventListener: (name, fn) => events.set(`${selector}:${name}`, fn) });
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
  const source = fs.readFileSync(new URL('../src/public/browser.js', import.meta.url), 'utf8').replace(/^import RFB[^\n]+\n/, '');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('RFB', 'document', 'sessionStorage', 'window', 'fetch', 'setInterval', 'setTimeout', 'clearTimeout', 'location', source)(RFB, document, sessionStorage, { addEventListener() {}, ReactNativeWebView: { postMessage: (message) => sent.push(JSON.parse(message)) } }, fetch, () => 1, () => 1, () => {}, { href: 'https://runtime.example/browser/', protocol: 'https:' });
  assert.equal(sent.length, 0);
  await events.get('#release:click')();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'browser.control.returned');
  assert.equal(sent[0].browser.targetId, 'tab_1');
  assert.doesNotMatch(JSON.stringify(sent[0]), /private-controller|private-token|ticket/);
  assert.equal(storage.has('browser-use-controller'), false);
});
