import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CALL_READ_INTERACTIONS, INTERACTION_KINDS_V2 } from '@knowscroll/scroll-model';

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

/**
 * The play blocks of a Scroll (a sort, a fork, a scale, a growing chart, D-207) are played on the device and
 * store nothing, so they sit behind the same wall by having nowhere to cross it: the play schema holds the
 * calls, the Scroll results and the landmarks, and no table for a block. A table added for one would have to
 * be named here, and so be seen.
 */
describe('what the play schema stores (D-063, D-209)', () => {
  const migrations = join(repository, 'migrations');

  it('is calls, Scroll results and landmarks: no table for a sort, a fork, a scale or a chart', () => {
    const created = readdirSync(migrations)
      .filter((name) => name.endsWith('.sql'))
      .flatMap((name) => [
        ...readFileSync(join(migrations, name), 'utf8').matchAll(/create table (?:if not exists )?play\.(\w+)/giu),
      ])
      .map((match) => match[1])
      .sort();
    expect(created).toEqual(['calls', 'landmarks', 'scroll_results']);
  });

  it('can fail: a migration that created a table for a block would be found', () => {
    const planted = 'create table play.sort_attempts (id uuid);';
    expect([...planted.matchAll(/create table (?:if not exists )?play\.(\w+)/giu)].map((match) => match[1])).toEqual([
      'sort_attempts',
    ]);
  });
});

/**
 * The picture a wrong answer turns the stage to (D-383) is worked out on the device from the pick, so it sits behind the wall by never
 * crossing it: the document names the picture (`revealStage`), the reader shows it, and nothing about the pick or the turn is reported, stored,
 * ranked or planned on. Three things keep it so, and each can fail: the vocabulary of what a reader reports does not grow a kind for it, no
 * module that handles evidence, plans or ranks names the field, and the app that carries a pick to the server does not either.
 */
describe('the picture a wrong answer turns the stage to stays on the device (D-063, D-383)', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');
  const REVEAL_FIELD = /\brevealStage\b/;
  /** The only code that may name the field: the document and its producer, the renderer, and the content module that publishes and reviews Scrolls. */
  const MAY_NAME_IT = [/^packages\/scroll-model\//, /^packages\/ui\//, /^packages\/backend\/src\/modules\/content\//];

  it('is not a thing a reader reports: the interaction kinds of a call are still the two value-free ones', () => {
    expect(INTERACTION_KINDS_V2).toEqual({ call_it: ['locked', 'revealed'], final_call: ['locked', 'revealed'] });
    expect([...CALL_READ_INTERACTIONS]).toEqual(['locked', 'revealed']);
  });

  it('is named by the document, its producer, the renderer and the content module alone: no other module and no app', () => {
    const production = [...sourcesUnder('packages'), ...sourcesUnder('apps')].filter(
      (path) => !/\.test\.tsx?$/u.test(path) && !MAY_NAME_IT.some((allowed) => allowed.test(path)),
    );
    expect(production.length).toBeGreaterThan(500);
    expect(production.filter((path) => REVEAL_FIELD.test(read(path)))).toEqual([]);
  });

  it('can fail: the scan finds the field where it belongs, and in a file that should not name it', () => {
    const everything = [...sourcesUnder('packages'), ...sourcesUnder('apps')];
    const found = everything.filter((path) => REVEAL_FIELD.test(read(path)));
    expect(found).toContain('packages/scroll-model/src/v2/document.ts');
    expect(found).toContain('packages/ui/src/scroll/stage-reader/stage-reveal.ts');
    expect(REVEAL_FIELD.test('const next = call.revealStage;')).toBe(true);
    expect(REVEAL_FIELD.test('const next = call.reveal;')).toBe(false);
    // A module that ranked on it would be found by the first scan, because none of these paths may name it.
    expect(
      MAY_NAME_IT.some((allowed) => allowed.test('packages/backend/src/modules/composer/application/rank.ts')),
    ).toBe(false);
    expect(MAY_NAME_IT.some((allowed) => allowed.test('apps/client/features/encounter/play-session.ts'))).toBe(false);
  });
});
