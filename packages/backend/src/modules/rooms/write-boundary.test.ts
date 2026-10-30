import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Rooms never write to the personal universe (v3 R-2, AGENTS "Only actual personal Reel/Scroll encounters create
 * consumption evidence"; D-164). What a resident says, what a member says and what a room remembers are
 * conversation, not evidence: no code of this module may name a table of `experience`, `geography`, `composer`, `planner`,
 * `evidence` or `personal_context` as a target of a write, in SQL or in a query builder. This guard reads the module's
 * source, so a new adapter that does so fails here before it reaches a database. The integration test
 * `rooms-residents.test.ts` proves the same at run time with row counts.
 */
const PERSONAL_SCHEMAS = ['experience', 'geography', 'composer', 'planner', 'evidence', 'personal_context'] as const;
const schemas = PERSONAL_SCHEMAS.join('|');
const WRITES: readonly RegExp[] = [
  new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from|truncate(?:\\s+table)?)\\s+(?:${schemas})\\.\\w+`, 'i'),
  new RegExp(`\\b(?:insertInto|updateTable|deleteFrom|mergeInto)\\(\\s*['"\`](?:${schemas})\\.\\w+`, 'i'),
];

const violationsIn = (source: string): string[] => WRITES.flatMap((pattern) => source.match(pattern) ?? []);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

describe('what rooms may write', () => {
  it('names no table of the personal universe as the target of a write', () => {
    const files = sourceFiles(__dirname);
    expect(files.length).toBeGreaterThan(20);
    const found = files.flatMap((file) => violationsIn(readFileSync(file, 'utf8')).map((hit) => `${file}: ${hit}`));
    expect(found).toEqual([]);
  });

  it('would catch such a write, in SQL and in a query builder', () => {
    expect(violationsIn('await sql`insert into experience.exposures (id) values (1)`')).toHaveLength(1);
    expect(violationsIn('update geography.state set revision = 1')).toHaveLength(1);
    expect(violationsIn("db.deleteFrom('composer.decisions')")).toHaveLength(1);
    expect(violationsIn("db.insertInto('planner.state')")).toHaveLength(1);
    expect(violationsIn("db.selectFrom('experience.exposures')")).toEqual([]);
  });
});
