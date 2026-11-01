import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The SQL side of the wall round Watch together (D-063, D-258). Who joined a Reel with a room, and who shared it, is the person's own and
 * is kept in the room: no production file outside `modules/rooms/` may name `rooms.watch_sessions` or `rooms.watch_viewers` (or build a
 * `rooms.` table name from a variable), so it can never reach evidence, ranking, planning or formation. The only other place that knows
 * the schema is the generated types file, which describes every table and runs no query.
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'dist-gallery', '.expo', 'test-results', 'coverage', '.git']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const WATCH_TABLE = /\brooms\.(?:watch_sessions|watch_viewers|\$\{)/;

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
  paths.filter((path) => WATCH_TABLE.test(read(path)));

describe('who can read the Watch together tables', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is Rooms alone: no other production file names a Watch table', () => {
    const production = [...sourcesUnder('packages'), ...sourcesUnder('apps')].filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(production.length).toBeGreaterThan(500);
    expect(mentioning(production, read)).toEqual([]);
  });

  it('can fail: the scan finds the queries of Rooms itself and any file that names the tables', () => {
    const found = mentioning([...sourcesUnder('packages'), ...sourcesUnder('apps')], read);
    expect(found).toContain('packages/backend/src/modules/rooms/adapters/postgres-watch.ts');
    expect(found).toContain('packages/backend/src/modules/rooms/adapters/erasure.ts');
    expect(mentioning(['x.ts'], () => 'select account_id from rooms.watch_viewers')).toEqual(['x.ts']);
    expect(mentioning(['x.ts'], () => 'select 1 from rooms.watch_sessions')).toEqual(['x.ts']);
    expect(mentioning(['x.ts'], () => 'select 1 from rooms.${table}')).toEqual(['x.ts']);
    expect(mentioning(['x.ts'], () => 'select 1 from rooms.members')).toEqual([]);
  });
});
