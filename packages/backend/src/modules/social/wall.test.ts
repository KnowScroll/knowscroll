import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The SQL side of the wall around a pick on a thread's call (D-063, D-156). The import rule
 * `thread-pick-wall-only-listed-modules-import-social` in `.dependency-cruiser.cjs` stops the modules that rank,
 * plan or form places importing Social, but a module could still read a member's pick straight from the table. So
 * no production file outside `modules/social/` may name `social.thread_calls` (or build a `social.` table name): the
 * only other place that knows the schema is the generated types file, which describes every table and runs no query.
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'dist-gallery', '.expo', 'test-results', 'coverage', '.git']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const PICK_TABLE = /\bsocial\.(?:thread_calls|\$\{)/;

const ALLOWED = [
  /^packages\/backend\/src\/modules\/social\//,
  /^packages\/backend\/src\/infrastructure\/postgres\/database\.generated\.ts$/,
];

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourcesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The files, by repository-relative path, whose text names the picks table. */
function mentioning(paths: readonly string[], read: (path: string) => string): string[] {
  return paths.filter((path) => PICK_TABLE.test(read(path)));
}

describe('who can read the picks on a thread’s calls', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is Social alone: no other production file names social.thread_calls', () => {
    const production = [...sourcesUnder('packages'), ...sourcesUnder('apps')].filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(production.length).toBeGreaterThan(500);
    expect(mentioning(production, read)).toEqual([]);
  });

  it('can fail: the scan finds the queries of Social itself and any file that names the table', () => {
    const everything = [...sourcesUnder('packages'), ...sourcesUnder('apps')];
    const found = mentioning(everything, read);
    expect(found).toContain('packages/backend/src/modules/social/adapters/postgres-thread-calls.ts');
    expect(found).toContain('packages/backend/src/modules/social/adapters/erasure.ts');
    expect(
      mentioning(['somewhere/else.ts'], () => 'select option from social.thread_calls where thread_id = $1'),
    ).toEqual(['somewhere/else.ts']);
    expect(mentioning(['somewhere/else.ts'], () => 'delete from ${sql.table(`social.${table}`)}')).toEqual([
      'somewhere/else.ts',
    ]);
    expect(mentioning(['somewhere/else.ts'], () => 'select 1 from social.thread_places')).toEqual([]);
  });
});
