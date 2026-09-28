import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Backport the explicit fake-IP option to the pinned 2026.7.1-2 browser config.
// The shared SSRF implementation already supports it; no guard is disabled.
export function patchBrowserPolicy(source) {
  if (!source.includes('function resolveBrowserSsrFPolicy(cfg)')) throw new Error('Browser policy resolver missing');
  if (source.includes('const allowRfc2544BenchmarkRange = rawPolicy?.allowRfc2544BenchmarkRange;')) return source;
  const pairs = [
    ['const rawPolicy = cfg?.ssrfPolicy;', 'const rawPolicy = cfg?.ssrfPolicy;\n\tconst allowRfc2544BenchmarkRange = rawPolicy?.allowRfc2544BenchmarkRange;'],
    ['!allowedHostnames && !hostnameAllowlist) return {};', '!allowedHostnames && !hostnameAllowlist && allowRfc2544BenchmarkRange === void 0) return {};'],
    ['...allowedHostnames ? { allowedHostnames } : {},', '...allowRfc2544BenchmarkRange !== void 0 ? { allowRfc2544BenchmarkRange: allowRfc2544BenchmarkRange === true } : {},\n\t\t...allowedHostnames ? { allowedHostnames } : {},'],
  ];
  for (const [before, after] of pairs) {
    if (!source.includes(before)) throw new Error(`Browser policy patch target missing: ${before}`);
    source = source.replace(before, after);
  }
  return source;
}
export function patchBrowserSchema(source) {
  const before = 'ssrfPolicy: object({\n\t\t\tdangerouslyAllowPrivateNetwork: boolean().optional(),';
  const after = `${before}\n\t\t\tallowRfc2544BenchmarkRange: boolean().optional(),`;
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error('Browser SSRF schema missing');
  return source.replace(before, after);
}
export function patchBundle(root) {
  const dist = path.join(root, 'dist');
  for (const [marker, patch] of [['function resolveBrowserSsrFPolicy(cfg)', patchBrowserPolicy], ['ssrfPolicy: object({\n\t\t\tdangerouslyAllowPrivateNetwork:', patchBrowserSchema]]) {
    const matches = fs.readdirSync(dist).filter(name => name.endsWith('.js')).map(name => path.join(dist, name)).filter(file => fs.readFileSync(file, 'utf8').includes(marker));
    if (matches.length !== 1) throw new Error(`Expected one browser patch target, found ${matches.length}`);
    const file = matches[0];
    fs.writeFileSync(file, patch(fs.readFileSync(file, 'utf8')));
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) patchBundle(process.argv[2]);
