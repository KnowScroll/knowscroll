import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Demand is never evidence (#674, D-414). The gap tables (`supply.gaps`, `supply.gap_signals`, the private `supply.gap_signal_marks` and
 * the operator's `ops.supply_gaps`) say where readers ran out of content and what the library lacks. Supply owns them. Nothing that
 * ranks, plans, remembers or forms places may read them: not the Composer, Evidence, Personal Context or Geography, and no other module
 * either, whatever it is called today or tomorrow. This is an allow-list over the source text, as the planned-intent and Quick answer walls
 * are: only Supply, the generated database types and the operator's reviewed view list may name them. A module added here must be added on
 * purpose. (Callers that know where content runs out hand a signal to Supply's recorder; they never name a table.)
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const GAP_TABLES = /supply\.gaps?\b|gap_signal_marks|gap_signals\b|supply_gaps/u;

const ALLOWED = [
  /^packages\/backend\/src\/modules\/supply\//,
  /^packages\/backend\/src\/infrastructure\/postgres\/database\.generated\.ts$/,
  /^packages\/backend\/src\/infrastructure\/postgres\/ops-job-views\.ts$/,
];

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourcesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The files, by repository-relative path, whose text names a gap table. */
function mentioning(paths: readonly string[], read: (path: string) => string): string[] {
  return paths.filter((path) => GAP_TABLES.test(read(path)));
}

describe('who can name the gap tables on the server', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is Supply, which owns them, and nothing that ranks, plans, remembers or forms places', () => {
    const outside = sourcesUnder('packages/backend/src').filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(outside.length).toBeGreaterThan(500);
    expect(mentioning(outside, read)).toEqual([]);
    for (const wall of ['composer', 'evidence', 'personal-context', 'geography', 'planner', 'scenes', 'experience'])
      expect(
        mentioning(
          outside.filter((path) => path.includes(`/modules/${wall}/`)),
          read,
        ),
      ).toEqual([]);
  });

  it('can fail: the scan finds Supply, the types and the view list, and any other file that names a gap table', () => {
    const found = mentioning(sourcesUnder('packages/backend/src'), read);
    expect(found).toContain('packages/backend/src/modules/supply/adapters/postgres-gaps.ts');
    expect(found).toContain('packages/backend/src/infrastructure/postgres/database.generated.ts');
    expect(found).toContain('packages/backend/src/infrastructure/postgres/ops-job-views.ts');
    expect(mentioning(['composer/rank.ts'], () => 'select readers from supply.gaps where planet = $1')).toEqual([
      'composer/rank.ts',
    ]);
    expect(mentioning(['evidence/rank.ts'], () => 'select * from supply.gap_signals')).toEqual(['evidence/rank.ts']);
    expect(mentioning(['geography/form.ts'], () => 'from supply.gap_signal_marks')).toEqual(['geography/form.ts']);
    expect(mentioning(['personal-context/read.ts'], () => 'select * from ops.supply_gaps')).toEqual([
      'personal-context/read.ts',
    ]);
    expect(mentioning(['composer/rank.ts'], () => 'import { RECORD_GAP_SIGNALS } from supply')).toEqual([]);
    expect(mentioning(['composer/rank.ts'], () => 'select 1 from supply.requests')).toEqual([]);
  });

  it('keeps the Composer’s side of it to a pure reading of the decision and a recorder it is handed', () => {
    const composer = sourcesUnder('packages/backend/src/modules/composer').filter((path) => !path.endsWith('.test.ts'));
    const imports = composer.flatMap((path) =>
      [...read(path).matchAll(/from '([^']*supply[^']*)'/gu)].map((match) => `${path}: ${match[1] ?? ''}`),
    );
    expect(imports).toEqual([]);
  });
});
