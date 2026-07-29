#!/usr/bin/env node
/**
 * Patch OpenClaw 2026.7.1's Memory Core legacy-state convergence.
 *
 * The 2026.7.1 startup checkpoint rejects every unresolved migration warning.
 * Two otherwise-safe duplicate-state cases currently remain as warnings:
 *
 * 1. Dreaming JSON state is left in place when canonical plugin-state rows
 *    already exist.
 * 2. A legacy memory sidecar whose metadata differs from an already-populated
 *    canonical per-agent index is left in place.
 *
 * Both cases make every subsequent Gateway startup fail. The patch archives
 * the legacy source through OpenClaw's existing lossless archive helpers.
 * Archive failures still emit warnings and therefore remain fail-closed.
 *
 * Used in two places:
 *  - postinstall (dev): patches `node_modules/openclaw/dist`
 *  - bundle-openclaw.mjs (production): patches the copied runtime
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MEMORY_CORE_DOCTOR_PATH = join(
  'extensions',
  'memory-core',
  'doctor-contract-api.js',
);

const META_ASSERT_ORIGINAL = `\tassertLegacyRowsCopied(db, \`SELECT COUNT(*) AS missing
     FROM \${schema}.meta AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.\${MEMORY_INDEX_META_TABLE} AS canonical
       WHERE canonical.key = legacy.key AND canonical.value IS legacy.value
     )\`, "meta");`;
const META_ASSERT_PATCHED = `\t/* oneclaw: keep populated canonical index metadata while merging legacy rows */
\tassertLegacyRowsCopied(db, \`SELECT COUNT(*) AS missing
     FROM \${schema}.meta AS legacy
     WHERE NOT EXISTS (
       SELECT 1 FROM main.\${MEMORY_INDEX_META_TABLE} AS canonical
       WHERE canonical.key = legacy.key AND canonical.value IS legacy.value
     )
       AND NOT (
         legacy.key = '\${MEMORY_INDEX_META_KEY}'
         AND (
           EXISTS (SELECT 1 FROM main.\${MEMORY_INDEX_SOURCES_TABLE} LIMIT 1)
           OR EXISTS (SELECT 1 FROM main.\${MEMORY_INDEX_CHUNKS_TABLE} LIMIT 1)
         )
       )\`, "meta");`;

// Normalize the first local iteration of this patch if a developer ran it
// before updating. It was never released, but keeping this transition makes
// repeated postinstall runs deterministic in dirty development environments.
const EARLY_META_CONFLICT_PATCH = `if (err instanceof LegacyMemoryRowsConflictError && (err.tableName === "files" || err.tableName === "meta" && (tableRowCount(db, "main", MEMORY_INDEX_SOURCES_TABLE) > 0 || tableRowCount(db, "main", MEMORY_INDEX_CHUNKS_TABLE) > 0))) {
\t\t\t\t/* oneclaw: canonical memory index wins over conflicting legacy metadata */`;
const UPSTREAM_META_CONFLICT_HANDLER = 'if (err instanceof LegacyMemoryRowsConflictError && err.tableName === "files") {';

const DUPLICATE_DREAMING_ORIGINAL = `\t\t\tif ((await Promise.all(targetNamespacesForSource(source.label).map((namespace) => workspaceHasRows(namespace, source.workspaceDir)))).some(Boolean)) {
\t\t\t\twarnings.push(\`Skipped Memory Core \${source.label} import for \${source.workspaceDir} because SQLite rows already exist; left legacy source in place\`);
\t\t\t\tcontinue;
\t\t\t}`;
const DUPLICATE_DREAMING_PATCHED = `\t\t\tif ((await Promise.all(targetNamespacesForSource(source.label).map((namespace) => workspaceHasRows(namespace, source.workspaceDir)))).some(Boolean)) {
\t\t\t\t/* oneclaw: archive duplicate legacy dreaming state after canonical rows win */
\t\t\t\tawait archiveLegacyStateSource({
\t\t\t\t\tfilePath: source.filePath,
\t\t\t\t\tlabel: \`Memory Core \${source.label}\`,
\t\t\t\t\tchanges,
\t\t\t\t\twarnings
\t\t\t\t});
\t\t\t\tcontinue;
\t\t\t}`;

function replaceExactlyOnce(content, original, patched, label) {
  if (content.includes(patched)) {
    return { content, changed: false };
  }

  const first = content.indexOf(original);
  const last = content.lastIndexOf(original);
  if (first === -1) {
    throw new Error(
      `[patch-openclaw-memory-migration] ${label} anchor was not found; `
      + 'review the patch before changing the bundled OpenClaw version.',
    );
  }
  if (first !== last) {
    throw new Error(
      `[patch-openclaw-memory-migration] ${label} anchor was found more than once; `
      + 'refusing an ambiguous runtime patch.',
    );
  }

  return {
    content: content.replace(original, patched),
    changed: true,
  };
}

/**
 * Patch the Memory Core doctor migration in an OpenClaw dist directory.
 * Missing runtimes are ignored so postinstall remains usable before OpenClaw
 * has been installed. A present but incompatible runtime fails closed.
 *
 * @param {string} distDir path to an `openclaw/dist` directory
 * @returns {number} number of files patched
 */
export function patchOpenclawMemoryMigration(distDir) {
  const filePath = join(distDir, MEMORY_CORE_DOCTOR_PATH);
  let content;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }
    throw error;
  }

  let normalizedEarlyPatch = false;
  if (content.includes(EARLY_META_CONFLICT_PATCH)) {
    content = content.replace(EARLY_META_CONFLICT_PATCH, UPSTREAM_META_CONFLICT_HANDLER);
    normalizedEarlyPatch = true;
  }

  const metaResult = replaceExactlyOnce(
    content,
    META_ASSERT_ORIGINAL,
    META_ASSERT_PATCHED,
    'legacy meta conflict',
  );
  const dreamingResult = replaceExactlyOnce(
    metaResult.content,
    DUPLICATE_DREAMING_ORIGINAL,
    DUPLICATE_DREAMING_PATCHED,
    'duplicate dreaming state',
  );

  if (!normalizedEarlyPatch && !metaResult.changed && !dreamingResult.changed) {
    return 0;
  }

  writeFileSync(filePath, dreamingResult.content, 'utf8');
  console.log(`[patch-openclaw-memory-migration] Patched: ${MEMORY_CORE_DOCTOR_PATH}`);
  return 1;
}

export const testing = {
  duplicateDreamingOriginal: DUPLICATE_DREAMING_ORIGINAL,
  metaAssertOriginal: META_ASSERT_ORIGINAL,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  patchOpenclawMemoryMigration(
    process.argv[2] || join(process.cwd(), 'node_modules', 'openclaw', 'dist'),
  );
}
