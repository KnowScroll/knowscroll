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
 * The same holds for SQL: no migration or operations script except Social's own may name the table, so a view, a
 * trigger or a function over the picks cannot be added from outside Social.
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'dist-gallery', '.expo', 'test-results', 'coverage', '.git']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const SQL = /\.sql$/;
const PICK_TABLE = /\bsocial\.(?:thread_calls|\$\{)/;
/** In SQL the table can be named without its schema (after `set search_path`), so the bare name counts too. */
const PICK_TABLE_IN_SQL = /\bthread_calls\b/;

const ALLOWED = [
  /^packages\/backend\/src\/modules\/social\//,
  /^packages\/backend\/src\/infrastructure\/postgres\/database\.generated\.ts$/,
];
/** Social's own migrations. A later Social migration that alters the table is added here, on purpose. */
const SOCIAL_MIGRATIONS = [/^migrations\/0083_thread_calls\.sql$/];

function filesUnder(folder: string, wanted: RegExp): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : filesUnder(path, wanted);
    return wanted.test(entry.name) ? [path] : [];
  });
}
const sourcesUnder = (folder: string) => filesUnder(folder, SOURCE);
const sqlUnder = (folder: string) => filesUnder(folder, SQL);

/** The files, by repository-relative path, whose text names the picks table. */
function mentioning(paths: readonly string[], read: (path: string) => string, table = PICK_TABLE): string[] {
  return paths.filter((path) => table.test(read(path)));
}

describe('who can read the picks on a thread’s calls', { timeout: 30_000 }, () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is Social alone: no other production file names social.thread_calls', () => {
    const production = [...sourcesUnder('packages'), ...sourcesUnder('apps')].filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(production.length).toBeGreaterThan(500);
    expect(mentioning(production, read)).toEqual([]);
  });

  it('is Social alone in SQL: no migration but Social’s own, and no operations script, names thread_calls', () => {
    const scripts = [
      ...sqlUnder('migrations'),
      ...sqlUnder('ops'),
      ...sqlUnder('packages'),
      ...sqlUnder('apps'),
    ].filter((path) => !SOCIAL_MIGRATIONS.some((allowed) => allowed.test(path)));
    expect(scripts.length).toBeGreaterThan(50);
    expect(mentioning(scripts, read, PICK_TABLE_IN_SQL)).toEqual([]);
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

  it('can fail in SQL: Social’s own migration is found, and a view or a bare name elsewhere would be', () => {
    expect(mentioning(sqlUnder('migrations'), read, PICK_TABLE_IN_SQL)).toEqual(['migrations/0083_thread_calls.sql']);
    const planted = 'create view ops.pick_counts as select option, count(*) from social.thread_calls group by option';
    expect(mentioning(['migrations/9999_view.sql'], () => planted, PICK_TABLE_IN_SQL)).toEqual([
      'migrations/9999_view.sql',
    ]);
    expect(mentioning(['migrations/9999_view.sql'], () => 'select 1 from thread_calls', PICK_TABLE_IN_SQL)).toEqual([
      'migrations/9999_view.sql',
    ]);
    expect(mentioning(['migrations/9999_view.sql'], () => 'select 1 from thread_places', PICK_TABLE_IN_SQL)).toEqual(
      [],
    );
    // The reveal days name no pick, so their table is not walled.
    expect(
      mentioning(['migrations/9999_view.sql'], () => 'select 1 from thread_call_reveals', PICK_TABLE_IN_SQL),
    ).toEqual([]);
  });
});
