import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What the Planner's model wanted of an opportunity (its move, the unit and its own brief) is model text about one person.
 * It is kept on that person's own demand row so a later step can commission from it, and it is never evidence, never part
 * of a shared group or a canonical brief, and never read by another person or another module. Supply owns the row and the
 * Planner builds the value from its opportunity; so this is an allow-list over the source text: no other module (Composer,
 * Evidence, Personal Context, Geography, Scenes, Experience, Rooms, Social, Content, the reasoning engine) may name it.
 * A module added here must be added on purpose.
 */
const repository = fileURLToPath(new URL('../../../../../', import.meta.url));
const SKIPPED_FOLDERS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const SOURCE = /\.(?:ts|tsx|mjs|cjs|js)$/;
const PLANNED_INTENT = /planned[-_ ]?intent/iu;

const ALLOWED = [
  /^packages\/backend\/src\/modules\/(?:supply|planner)\//,
  /^packages\/backend\/src\/infrastructure\/postgres\/database\.generated\.ts$/,
];

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(repository, folder), { withFileTypes: true }).flatMap((entry) => {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourcesUnder(path);
    return SOURCE.test(entry.name) ? [path] : [];
  });
}

/** The files, by repository-relative path, whose text names the planned intent. */
function mentioning(paths: readonly string[], read: (path: string) => string): string[] {
  return paths.filter((path) => PLANNED_INTENT.test(read(path)));
}

describe('who can name the planned intent on the server', () => {
  const read = (path: string) => readFileSync(join(repository, path), 'utf8');

  it('is Supply, which owns the row, and the Planner, which builds it: nothing that ranks, remembers, forms places or reads for others', () => {
    const backend = sourcesUnder('packages/backend/src').filter(
      (path) => !ALLOWED.some((allowed) => allowed.test(path)),
    );
    expect(backend.length).toBeGreaterThan(500);
    expect(mentioning(backend, read)).toEqual([]);
  });

  it('can fail: the scan finds Supply and the Planner, and any other file that names it', () => {
    const found = mentioning(sourcesUnder('packages/backend/src'), read);
    expect(found).toContain('packages/backend/src/modules/supply/adapters/postgres-store.ts');
    expect(found).toContain('packages/backend/src/modules/planner/application/demand.ts');
    expect(mentioning(['composer/rank.ts'], () => 'select planned_intent from supply.requests')).toEqual([
      'composer/rank.ts',
    ]);
    expect(mentioning(['content/discovery.ts'], () => 'demand.plannedIntent.brief')).toEqual(['content/discovery.ts']);
    expect(mentioning(['composer/rank.ts'], () => 'select 1 from supply.ask_orders')).toEqual([]);
  });
});
