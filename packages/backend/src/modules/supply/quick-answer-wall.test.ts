import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A Quick answer never reaches the Universe (V3 D2, D-086, D-253). It is model text, shown once and kept a day; it is not
 * a Scroll, not an encounter and not evidence. The import rules cannot say it: Supply is imported by modules that plan
 * (the Planner records demand through it), so a module could reach a Quick answer through Supply's public surface, and
 * a module could read its table directly. So this is an allow-list over the source text: the only places that may name a
 * Quick answer, its tables, its queues or its ports are Supply, which owns it, Content (the passages it may rest on),
 * Feedback (a report keeps its words), and the few files that list every table, queue, setting and event (the operator's retention panel names the purge queue). Anything else
 * (Composer, Jev, the Planner, Evidence, Personal Context, Geography, Scenes, Experience, Rooms, Social, the reasoning
 * engine) failing this test is the wall doing its work: a later module must be added here on purpose.
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const QUICK_ANSWER = /quick[-_ ]?answer/iu;

const ALLOWED = [
  /^packages\/backend\/src\/modules\/(?:supply|content|feedback)\//,
  /^packages\/backend\/src\/infrastructure\/config\/processes(?:\.test)?\.ts$/,
  /^packages\/backend\/src\/infrastructure\/observability\/catalogue\.ts$/,
  /^packages\/backend\/src\/infrastructure\/postgres\/database\.generated\.ts$/,
  /^packages\/backend\/src\/job-queues\.ts$/,
  // The operator's retention panel lists the purge job by its queue name; it reads no answer.
  /^packages\/backend\/src\/modules\/operator\/domain\/panels\.ts$/,
];

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourcesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The files, by repository-relative path, whose text names a Quick answer. */
function mentioning(paths: readonly string[], read: (path: string) => string): string[] {
  return paths.filter((path) => QUICK_ANSWER.test(read(path)));
}

describe('who can name a Quick answer on the server', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is Supply, Content, Feedback and the files that list every store: no module that ranks, plans, remembers or forms places', () => {
    const backend = sourcesUnder('packages/backend/src').filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(backend.length).toBeGreaterThan(500);
    expect(mentioning(backend, read)).toEqual([]);
  });

  it('can fail: the scan finds Supply itself and any other file that names one', () => {
    const everything = sourcesUnder('packages/backend/src');
    const found = mentioning(everything, read);
    expect(found).toContain('packages/backend/src/modules/supply/adapters/postgres-quick-answers.ts');
    expect(found).toContain('packages/backend/src/modules/content/adapters/scroll-quick-answer-facts.ts');
    expect(mentioning(['planner/plan.ts'], () => 'select answer from supply.quick_answers')).toEqual([
      'planner/plan.ts',
    ]);
    expect(mentioning(['composer/rank.ts'], () => "import { READ_QUICK_ANSWER } from '../supply/public.js'")).toEqual([
      'composer/rank.ts',
    ]);
    expect(mentioning(['composer/rank.ts'], () => 'select 1 from supply.ask_orders')).toEqual([]);
  });
});

/**
 * Nothing about asking reaches the evidence tables. The Quick answer's use cases never import Evidence, Experience (but
 * for the one check that the person has opened the Scroll), Composer, the Planner, Personal Context, Geography or Scenes.
 */
const FORBIDDEN_IMPORT =
  /from '\.\.\/\.\.\/(?:evidence|composer|planner|personal-context|geography|scenes|rooms|social)\//u;

describe('what the Quick answer imports', () => {
  it('is identity, content and experience public surfaces, the reasoning engine and infrastructure, and nothing that derives from behaviour', () => {
    const files = sourcesUnder('packages/backend/src/modules/supply').filter(
      (path) => /quick-answer|quick-answers/u.test(path) && !path.endsWith('.test.ts'),
    );
    expect(files.length).toBeGreaterThanOrEqual(6);
    const offenders = files.filter((path) => FORBIDDEN_IMPORT.test(readFileSync(join(repository, path), 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('can fail: an import of Evidence, the Planner or Composer from a Quick answer file would be found', () => {
    expect(FORBIDDEN_IMPORT.test("import { x } from '../../evidence/public.js';")).toBe(true);
    expect(FORBIDDEN_IMPORT.test("import { x } from '../../planner/public.js';")).toBe(true);
    expect(FORBIDDEN_IMPORT.test("import { x } from '../../identity/public.js';")).toBe(false);
  });
});
