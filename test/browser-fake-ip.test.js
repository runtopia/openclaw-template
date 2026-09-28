import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchBrowserPolicy, patchBrowserSchema } from '../scripts/patch-openclaw-browser-fake-ip.mjs';
import { applyBrowserDefaults } from '../src/config/browser.js';
const source = `function resolveBrowserSsrFPolicy(cfg) {
 const rawPolicy = cfg?.ssrfPolicy;
 const allowedHostnames = rawPolicy?.allowedHostnames;
 const hostnameAllowlist = rawPolicy?.hostnameAllowlist;
 const hasExplicitPrivateSetting = rawPolicy?.dangerouslyAllowPrivateNetwork !== undefined;
 const resolvedAllowPrivateNetwork = rawPolicy?.dangerouslyAllowPrivateNetwork === true;
 if (!resolvedAllowPrivateNetwork && !hasExplicitPrivateSetting && !allowedHostnames && !hostnameAllowlist) return {};
 return {
 dangerouslyAllowPrivateNetwork: resolvedAllowPrivateNetwork,
 ...allowedHostnames ? { allowedHostnames } : {},
 ...hostnameAllowlist ? { hostnameAllowlist } : {}
 };
}`;
test('preserves strict defaults, propagates only explicit fake-IP opt-in, and is idempotent', () => {
 const patched = patchBrowserPolicy(source);
 assert.equal(patchBrowserPolicy(patched), patched);
 const resolve = vm.runInNewContext(`${patched}; resolveBrowserSsrFPolicy`);
 assert.equal(JSON.stringify(resolve({})), '{}');
 assert.equal(resolve({ ssrfPolicy: { allowRfc2544BenchmarkRange: true } }).allowRfc2544BenchmarkRange, true);
 assert.equal(resolve({ ssrfPolicy: { allowRfc2544BenchmarkRange: true } }).dangerouslyAllowPrivateNetwork, false);
 assert.equal(resolve({ ssrfPolicy: { allowRfc2544BenchmarkRange: false } }).allowRfc2544BenchmarkRange, false);
 assert.throws(() => patchBrowserPolicy('wrong version'));
 const schema = 'ssrfPolicy: object({\n\t\t\tdangerouslyAllowPrivateNetwork: boolean().optional(),';
 assert.equal(patchBrowserSchema(patchBrowserSchema(schema)), patchBrowserSchema(schema));
});
test('image defaults to narrow fake-IP compatibility and honors explicit opt-out', () => {
 const cfg = {};
 applyBrowserDefaults(cfg, { ONECLAW_BROWSER_ENABLED: '1' });
 assert.deepEqual(cfg.browser.ssrfPolicy, { allowRfc2544BenchmarkRange: true });
 applyBrowserDefaults(cfg, { ONECLAW_BROWSER_ENABLED: '1', ONECLAW_BROWSER_ALLOW_FAKE_IP: '1' });
 assert.deepEqual(cfg.browser.ssrfPolicy, { allowRfc2544BenchmarkRange: true });
 applyBrowserDefaults(cfg, { ONECLAW_BROWSER_ENABLED: '1', ONECLAW_BROWSER_ALLOW_FAKE_IP: '0' });
 assert.equal(cfg.browser.ssrfPolicy.allowRfc2544BenchmarkRange, false);
 applyBrowserDefaults(cfg, { ONECLAW_BROWSER_ENABLED: '1' });
 assert.equal(cfg.browser.ssrfPolicy.allowRfc2544BenchmarkRange, false);
 assert.equal(cfg.browser.ssrfPolicy.dangerouslyAllowPrivateNetwork, undefined);
});
