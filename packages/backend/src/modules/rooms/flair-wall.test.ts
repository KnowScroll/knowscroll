import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The wall around flair (D-063, D-347). Flair is worked out from a person's own acts in a room: their words, the Useful marks on
 * their questions, their right taps on Spot the flaw and their answers in a Launch. It is a mark of a room, not evidence, so it never
 * feeds ranking, planning, Personal Context, geography or formation, and nothing in those modules may read what it is made from.
 *
 * Two sides. The import rule `launch-wall-only-listed-modules-import-rooms` already stops those modules importing Rooms at all. This
 * file closes the other two doors: no production file outside `modules/rooms/` may name the tables flair is read from or the column
 * that holds a person's choice (the generated types describe every table and run no query), and the files that make flair import no
 * module of the personal universe, so flair could not be handed to one even from inside Rooms.
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', 'dist-gallery', '.expo', 'test-results', 'coverage', '.git']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const FLAIR_SOURCES = /\brooms\.(?:ritual_solves|message_useful|stars\b|members\b|\$\{)|\bflair_choice\b/;
const ALLOWED = [
  /^packages\/backend\/src\/modules\/rooms\//,
  /^packages\/backend\/src\/infrastructure\/postgres\/database\.generated\.ts$/,
];
/** The modules of the personal universe: where a person's reading, planning and places live. */
const PERSONAL_MODULES = ['experience', 'geography', 'composer', 'planner', 'evidence', 'personal-context', 'scenes'];
const PERSONAL_IMPORT = new RegExp(
  `from\\s+['"][^'"]*modules/(?:${PERSONAL_MODULES.join('|')})/|from\\s+['"]\\.\\./\\.\\./(?:${PERSONAL_MODULES.join('|')})/`,
);
const FLAIR_FILES = [
  'packages/backend/src/modules/rooms/domain/flair.ts',
  'packages/backend/src/modules/rooms/application/flair.ts',
  'packages/backend/src/modules/rooms/application/flair-ports.ts',
  'packages/backend/src/modules/rooms/adapters/postgres-flair.ts',
];

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourcesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

const mentioning = (paths: readonly string[], read: (path: string) => string): string[] =>
  paths.filter((path) => FLAIR_SOURCES.test(read(path)));
const importingPersonal = (paths: readonly string[], read: (path: string) => string): string[] =>
  paths.filter((path) => PERSONAL_IMPORT.test(read(path)));

describe('who can read what flair is made from', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is Rooms alone: no other production file names those tables or a person’s flair choice', () => {
    const production = [...sourcesUnder('packages'), ...sourcesUnder('apps')].filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(production.length).toBeGreaterThan(500);
    expect(mentioning(production, read)).toEqual([]);
  });

  it('can fail: the scan finds the queries of Rooms itself and any file that names the tables or the column', () => {
    const found = mentioning([...sourcesUnder('packages'), ...sourcesUnder('apps')], read);
    expect(found).toContain('packages/backend/src/modules/rooms/adapters/postgres-flair.ts');
    expect(found).toContain('packages/backend/src/modules/rooms/adapters/erasure.ts');
    expect(mentioning(['x.ts'], () => 'select count(*) from rooms.ritual_solves where account_id = $1')).toEqual([
      'x.ts',
    ]);
    expect(mentioning(['x.ts'], () => 'select 1 from rooms.message_useful')).toEqual(['x.ts']);
    expect(mentioning(['x.ts'], () => 'select flair_choice from members')).toEqual(['x.ts']);
    expect(mentioning(['x.ts'], () => 'delete from ${sql.table(`rooms.${table}`)}')).toEqual(['x.ts']);
    expect(mentioning(['x.ts'], () => 'select 1 from rooms.stars_view')).toEqual([]);
    expect(mentioning(['x.ts'], () => 'select 1 from experience.play_counts')).toEqual([]);
  });
});

describe('where flair is allowed to go', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is made by files that import no module of the personal universe', () => {
    for (const path of FLAIR_FILES) expect(read(path).length, path).toBeGreaterThan(200);
    expect(importingPersonal(FLAIR_FILES, read)).toEqual([]);
  });

  it('can fail: an import of a personal module is found, in either spelling, and Rooms’ own and Social’s are not', () => {
    expect(importingPersonal(['x.ts'], () => "import { x } from '../../experience/public.js';")).toEqual(['x.ts']);
    expect(
      importingPersonal(['x.ts'], () => "import { x } from '@knowscroll/backend/modules/planner/public.js';"),
    ).toEqual(['x.ts']);
    expect(importingPersonal(['x.ts'], () => "import { x } from '../../social/public.js';")).toEqual([]);
    expect(importingPersonal(['x.ts'], () => "import { x } from './ports.js';")).toEqual([]);
  });
});
