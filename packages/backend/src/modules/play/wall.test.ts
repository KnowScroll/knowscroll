import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The SQL side of the play wall (D-063, D-180). The import rules in `.dependency-cruiser.cjs` stop
 * modules importing `play`, but a module could still read the person's picks straight from the
 * tables. So no production file outside `modules/play/` may name `play.calls`, `play.scroll_results` or `play.landmarks`
 * (or build a `play.` table name): the only other place that knows the schema is the generated types
 * file, which describes every table and runs no query.
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'dist-gallery', '.expo', 'test-results', 'coverage', '.git']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const PLAY_TABLE = /\bplay\.(?:calls|scroll_results|landmarks|\$\{)/;

const ALLOWED = [
  /^packages\/backend\/src\/modules\/play\//,
  /^packages\/backend\/src\/infrastructure\/postgres\/database\.generated\.ts$/,
];

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourcesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The files, by repository-relative path, whose text names a play table. */
function mentioning(paths: readonly string[], read: (path: string) => string): string[] {
  return paths.filter((path) => PLAY_TABLE.test(read(path)));
}

describe('who can read the play tables', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is play alone: no other production file names play.calls, play.scroll_results or play.landmarks', () => {
    const production = [...sourcesUnder('packages'), ...sourcesUnder('apps')].filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(production.length).toBeGreaterThan(500);
    expect(mentioning(production, read)).toEqual([]);
  });

  it('can fail: the scan finds the queries of play itself and any file that names the tables', () => {
    const everything = [...sourcesUnder('packages'), ...sourcesUnder('apps')];
    const found = mentioning(everything, read);
    expect(found).toContain('packages/backend/src/modules/play/adapters/play-store.ts');
    expect(found).toContain('packages/backend/src/modules/play/adapters/erasure.ts');
    expect(mentioning(['somewhere/else.ts'], () => 'select stop_id from play.calls where universe_id = $1')).toEqual([
      'somewhere/else.ts',
    ]);
    expect(mentioning(['somewhere/else.ts'], () => 'delete from ${sql.table(`play.${table}`)}')).toEqual([
      'somewhere/else.ts',
    ]);
    expect(mentioning(['somewhere/else.ts'], () => 'select 1 from experience.play_counts')).toEqual([]);
  });
});
