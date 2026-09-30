import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchStrictBrowserTarget, patchBrowserNavigationDeadline, patchTaskBrowserWindows } from '../scripts/patch-openclaw-browser-target.mjs';
import { applyBrowserDefaults } from '../src/config/browser.js';

test('managed browser never falls back to another session sole remaining page', async () => {
  const source = `async function getPageForTargetIdOnce(opts) {
    const pages = ['other-task'], first = pages[0];
    if (pages.length === 1) return first;
    throw new Error('PAGE_GONE');
  }
async function getPageForTargetId(opts) { return getPageForTargetIdOnce(opts); }`;
  const patched = patchStrictBrowserTarget(source);
  assert.equal(patchStrictBrowserTarget(patched), patched);
  const run = enabled => vm.runInNewContext(patched + '\ngetPageForTargetId({targetId:"missing"})', { process: { env: { ONECLAW_BROWSER_USE_ENABLED: enabled } } });
  await assert.rejects(run('1'), /PAGE_GONE/);
  assert.equal(await run('0'), 'other-task');
  assert.throws(() => patchStrictBrowserTarget(source.replace('pages.length === 1', 'pages.length < 2')), /anchor/);
});

test('OneClaw owns periodic page cleanup only when handoff is enabled', () => {
  const managed = { browser: { tabCleanup: { enabled: true, idleMinutes: 5 } } };
  applyBrowserDefaults(managed, { ONECLAW_BROWSER_ENABLED: '1', ONECLAW_BROWSER_USE_ENABLED: '1' });
  assert.deepEqual(managed.browser.tabCleanup, { enabled: false, idleMinutes: 5 });
  const standalone = { browser: { tabCleanup: { enabled: true } } };
  applyBrowserDefaults(standalone, { ONECLAW_BROWSER_ENABLED: '1', ONECLAW_BROWSER_USE_ENABLED: '0' });
  assert.equal(standalone.browser.tabCleanup.enabled, true);
});

 test('navigation request leaves time for the native operation to finish without replaying it', async () => {
  const source = `async function browserNavigate(baseUrl, opts) {
    return await fetchBrowserJson(baseUrl, {timeoutMs: 2e4});
  }
async function browserArmDialog(baseUrl, opts) { return 'untouched'; }`;
  const patched = patchBrowserNavigationDeadline(source);
  assert.equal(patchBrowserNavigationDeadline(patched), patched);
  let requests = 0;
  const evaluate = enabled => vm.runInNewContext(patched + '\nbrowserNavigate("test",{})', {
    process: { env: { ONECLAW_BROWSER_USE_ENABLED: enabled } }, fetchBrowserJson: async (_base, opts) => { requests++; return opts.timeoutMs; }
  });
  assert.equal(await evaluate('1'), 60000); assert.equal(await evaluate('0'), 20000);
  assert.equal(requests, 2, 'one navigation per invocation, never retry a partially completed action');
  assert.throws(() => patchBrowserNavigationDeadline(source.replace('2e4', '3e4')), /anchor/);
 });

 test('managed pages create their own maximized window while other hosts keep native tab behavior',async()=>{
  const source=`async function createTargetViaCdp(opts) {
    const targetId=(await send("Target.createTarget", { url: opts.url }))?.targetId;
    await prepareCdpTargetSession(send, targetId);
    return {targetId};
  }
async function prepareCdpTargetSession(send,targetId) {}`;
  const patched=patchTaskBrowserWindows(source);assert.equal(patchTaskBrowserWindows(patched),patched);
  for(const enabled of ['1','0']){
    const calls=[];
    const result=await vm.runInNewContext(patched+'\ncreateTargetViaCdp({url:"https://example.com"})',{process:{env:{ONECLAW_BROWSER_USE_ENABLED:enabled}},send:async(method,params)=>{calls.push({method,params});return method==='Target.createTarget'?{targetId:'new-owned-page'}:{windowId:7};}});
    assert.equal(result.targetId,'new-owned-page');assert.equal(calls[0].params.newWindow,enabled==='1'?true:undefined);
    assert.equal(calls.filter(c=>c.method==='Browser.setWindowBounds').length,enabled==='1'?1:0);
  }
  assert.throws(()=>patchTaskBrowserWindows(source.replace('url: opts.url','url: other')),/anchor/);
 });
