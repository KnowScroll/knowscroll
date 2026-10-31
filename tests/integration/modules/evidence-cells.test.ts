/**
 * Play-level format cells of Evidence (v3 S-5, D-192), over real PostgreSQL: where a reading's counts go, how a
 * correction moves them, and what the Composer context hands on. Labelled CI fixtures; the readings are counts, not
 * product data.
 */
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { moveCellCounts, readCells } from '../../../packages/backend/src/modules/evidence/adapters/cell-store.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';

describe('play-level format cells (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('evidence_cells');
  });
  afterAll(async () => {
    await database.drop();
  });

  const where = (person: FixturePerson, topicId: string, kind: 'reel' | 'scroll' = 'scroll') => ({
    universeId: person.universeId,
    privacyEpoch: 1,
    topicId,
    kind,
  });
  const cellsOf = async (person: FixturePerson, topicId: string) => {
    const entered = await withScope()(person.authority, (scope) => readCells(scope, [topicId]));
    if (entered.kind !== 'entered') throw new Error('CI expected the scope to open');
    return entered.value.get(topicId) ?? [];
  };
  const counted = { measured: 1, qualified: 1 } as const;

  it('counts a reading in the cell of the level of the Scroll read, and nowhere else', async () => {
    const person = await seedPerson(database.db);
    await moveCellCounts(database.db, where(person, 'earth.seasons'), undefined, { level: 'game', ...counted });
    await moveCellCounts(database.db, where(person, 'earth.seasons'), undefined, {
      level: 'plain',
      measured: 1,
      qualified: 0,
    });
    expect(await cellsOf(person, 'earth.seasons')).toEqual([
      { kind: 'scroll', level: 'game', measured: 1, qualified: 1 },
      { kind: 'scroll', level: 'plain', measured: 1, qualified: 0 },
    ]);
    expect(await cellsOf(person, 'space.stars')).toEqual([]);
  });

  it('adds the difference when a correction keeps the level, and counts a reel apart from a scroll', async () => {
    const person = await seedPerson(database.db);
    const first = { level: 'stage', measured: 1, qualified: 0 } as const;
    await moveCellCounts(database.db, where(person, 't'), undefined, first);
    // The same exposure later qualifies: its counts change from 1/0 to 1/1.
    await moveCellCounts(database.db, where(person, 't'), first, { level: 'stage', ...counted });
    await moveCellCounts(database.db, where(person, 't', 'reel'), undefined, { level: 'plain', ...counted });
    expect(await cellsOf(person, 't')).toEqual([
      { kind: 'reel', level: 'plain', measured: 1, qualified: 1 },
      { kind: 'scroll', level: 'stage', measured: 1, qualified: 1 },
    ]);
  });

  it('moves the counts when the level of an exposure changes, as for one counted as plain before levels existed', async () => {
    const person = await seedPerson(database.db);
    // The migration made the old parent count a plain cell.
    await moveCellCounts(database.db, where(person, 't'), undefined, { level: 'plain', ...counted });
    await moveCellCounts(
      database.db,
      where(person, 't'),
      { level: 'plain', ...counted },
      { level: 'game', measured: 1, qualified: 0 },
    );
    expect(await cellsOf(person, 't')).toEqual([
      { kind: 'scroll', level: 'game', measured: 1, qualified: 0 },
      { kind: 'scroll', level: 'plain', measured: 0, qualified: 0 },
    ]);
  });

  it('never goes below zero or has more qualified than measured, when a process from before the migration counted the parent only', async () => {
    const person = await seedPerson(database.db);
    await moveCellCounts(
      database.db,
      where(person, 't'),
      { level: 'plain', ...counted },
      { level: 'plain', measured: 0, qualified: 0 },
    );
    await moveCellCounts(database.db, where(person, 't'), undefined, { level: 'stage', measured: 1, qualified: 0 });
    await moveCellCounts(
      database.db,
      where(person, 't'),
      { level: 'stage', measured: 2, qualified: 2 },
      { level: 'stage', measured: 0, qualified: 0 },
    );
    const cells = await cellsOf(person, 't');
    for (const cell of cells) {
      expect(cell.measured).toBeGreaterThanOrEqual(0);
      expect(cell.qualified).toBeGreaterThanOrEqual(0);
      expect(cell.qualified).toBeLessThanOrEqual(cell.measured);
    }
  });

  it('reads only the topics asked for, only the person’s own and only at their epoch', async () => {
    const person = await seedPerson(database.db);
    const other = await seedPerson(database.db);
    await moveCellCounts(database.db, where(person, 'a'), undefined, { level: 'game', ...counted });
    await moveCellCounts(database.db, where(person, 'b'), undefined, { level: 'game', ...counted });
    await moveCellCounts(database.db, where(other, 'a'), undefined, { level: 'stage', measured: 3, qualified: 0 });
    expect(await cellsOf(person, 'a')).toEqual([{ kind: 'scroll', level: 'game', measured: 1, qualified: 1 }]);
    expect(await cellsOf(other, 'a')).toEqual([{ kind: 'scroll', level: 'stage', measured: 3, qualified: 0 }]);
    const both = await withScope()(person.authority, (scope) => readCells(scope, ['a', 'b']));
    expect(both.kind === 'entered' && [...both.value.keys()].sort()).toEqual(['a', 'b']);
    // A person who cleared (the epoch moved on) does not read the cells of the old epoch.
    await sql`update identity.universes set privacy_epoch = 2 where id = ${person.universeId}::uuid`.execute(
      database.db,
    );
    const next = await withScope()({ ...person.authority, privacyEpoch: 2 }, (scope) => readCells(scope, ['a']));
    expect(next.kind === 'entered' && next.value.size).toBe(0);
  });
});
