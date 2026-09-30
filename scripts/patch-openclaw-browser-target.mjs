import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function patchStrictBrowserTarget(source) {
  const start = source.indexOf('async function getPageForTargetIdOnce(opts) {');
  const end = source.indexOf('\nasync function getPageForTargetId(opts)', start);
  if (start < 0 || end < start) throw new Error('Pinned browser target resolver missing');
  const before = 'if (pages.length === 1) return first;';
  const after = 'if (pages.length === 1 && process.env.ONECLAW_BROWSER_USE_ENABLED !== "1") return first;';
  const section = source.slice(start, end);
  if (section.includes(after)) return source;
  if (section.split(before).length !== 2) throw new Error('Pinned browser fallback anchor changed');
  return source.slice(0, start) + section.replace(before, after) + source.slice(end);
}

export function patchBundle(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== '2026.7.1-2') throw new Error('Revalidate strict-target patch for this OpenClaw version');
  const dist = path.join(root, 'dist');
  const files = fs.readdirSync(dist).filter(name => name.endsWith('.js')).map(name => path.join(dist, name))
    .filter(file => fs.readFileSync(file, 'utf8').includes('async function getPageForTargetIdOnce(opts) {'));
  if (files.length !== 1) throw new Error('Expected one pinned browser resolver');
  fs.writeFileSync(files[0], patchStrictBrowserTarget(fs.readFileSync(files[0], 'utf8')));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) patchBundle(process.argv[2]);
