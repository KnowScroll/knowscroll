import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The SQL side of the Launch wall (D-063, D-178, D-220). The import rule `launch-wall-only-listed-modules-import-rooms` stops
 * modules importing Rooms, but a module could still read a person's answers straight from the tables. So no production file outside
 * `modules/rooms/` may name `rooms.launch_answers`, `rooms.launch_players` or `rooms.launches` (or build a `rooms.` table name from
 * a variable): the only other place that knows the schema is the generated types file, which describes every table and runs no query.
 * Which option a person picked, and whether it was right, can therefore never reach evidence, ranking, planning or formation.
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'dist-gallery', '.expo', 'test-results', 'coverage', '.git']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const LAUNCH_TABLE = /\brooms\.(?:launch_answers|launch_players|launches\b|\$\{)/;

const ALLOWED = [
  /^packages\/backend\/src\/modules\/rooms\//,
  /^packages\/backend\/src\/infrastructure\/postgres\/database\.generated\.ts$/,
];

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourcesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

const mentioning = (paths: readonly string[], read: (path: string) => string): string[] =>
  paths.filter((path) => LAUNCH_TABLE.test(read(path)));

describe('who can read the Launch tables', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is Rooms alone: no other production file names a Launch table', () => {
    const production = [...sourcesUnder('packages'), ...sourcesUnder('apps')].filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(production.length).toBeGreaterThan(500);
    expect(mentioning(production, read)).toEqual([]);
  });

  it('can fail: the scan finds the queries of Rooms itself and any file that names the tables', () => {
    const found = mentioning([...sourcesUnder('packages'), ...sourcesUnder('apps')], read);
    expect(found).toContain('packages/backend/src/modules/rooms/adapters/postgres-launch.ts');
    expect(found).toContain('packages/backend/src/modules/rooms/adapters/erasure.ts');
    expect(mentioning(['x.ts'], () => 'select choice from rooms.launch_answers where account_id = $1')).toEqual([
      'x.ts',
    ]);
    expect(mentioning(['x.ts'], () => 'select 1 from rooms.launches')).toEqual(['x.ts']);
    expect(mentioning(['x.ts'], () => 'delete from ${sql.table(`rooms.${table}`)}')).toEqual(['x.ts']);
    expect(mentioning(['x.ts'], () => 'select 1 from rooms.launches_view')).toEqual([]);
    expect(mentioning(['x.ts'], () => 'select 1 from experience.play_counts')).toEqual([]);
  });
});
