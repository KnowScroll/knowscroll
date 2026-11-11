/**
 * The scheduled decision prune (`composer.prune-decisions`, #674) on real PostgreSQL. Labelled CI fixtures: decisions of
 * made-up inputs, a buffer row, and one navigation over the starter document. Nothing here is product data.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { composeEncounter, PRUNE_COMPOSER_DECISIONS, pruneDecisionsQueue } from '@knowscroll/backend/modules/composer';
import type { PruneDecisions } from '@knowscroll/backend/modules/composer';
import { composerPruneProviders, makeComposerStore } from '@knowscroll/backend/modules/composer/nest-providers';
import { releaseQueues } from '@knowscroll/backend/job-queues';
import { fixtureComposerSnapshot, seedComposerBuffer } from '../support/composer.js';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { buildFromProviders } from '../support/providers.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';

const DATABASE = Symbol('test.database');
const SCOPE = Symbol('test.withPersonalScope');

describe('the scheduled decision prune (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>;
  let prune: PruneDecisions;
  const withScope = () => makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 });
  const store = makeComposerStore({ isOperator: () => true });

  beforeAll(async () => {
    database = await createTestDatabase<Database>('composer_prune');
    prune = buildFromProviders(
      composerPruneProviders({ database: DATABASE, withPersonalScope: SCOPE }),
      PRUNE_COMPOSER_DECISIONS,
      new Map<symbol, unknown>([
        [DATABASE, database.db],
        [SCOPE, withScope()],
      ]),
    ) as PruneDecisions;
  });
  afterAll(async () => {
    await database.drop();
  });

  /** One stored decision for a person, made expired `daysAgo` days ago when asked. */
  async function decide(person: FixturePerson, expiredDaysAgo?: number): Promise<string> {
    const decisionId = randomUUID();
    await withScope()(person.authority, (scope) =>
      store.persistComposerDecision(
        scope,
        { decisionId, commandId: randomUUID() },
        composeEncounter(fixtureComposerSnapshot(person.authority)),
      ),
    );
    if (expiredDaysAgo !== undefined)
      await sql`update composer.decisions set recorded_at=now()-interval '30 days'-make_interval(days=>${expiredDaysAgo}::int),
        expires_at=now()-make_interval(days=>${expiredDaysAgo}::int) where id=${decisionId}::uuid`.execute(database.db);
    return decisionId;
  }
  const present = async (ids: readonly string[]) =>
    (
      await sql<{ id: string }>`select id from composer.decisions where id=any(${ids}::uuid[]) order by id`.execute(
        database.db,
      )
    ).rows.map((row) => row.id);

  it('is a declared release queue on a schedule, with no payload to name a person', () => {
    expect(releaseQueues.map((queue) => queue.name)).toContain(pruneDecisionsQueue.name);
    expect(pruneDecisionsQueue.schedule?.payload).toEqual({ v: 1 });
    expect(pruneDecisionsQueue.payload.safeParse({ v: 1, universeId: randomUUID() }).success).toBe(false);
  });

  it('deletes the expired decisions nothing holds, for every universe that has some, and nothing else', async () => {
    const a = await seedPerson(database.db);
    const b = await seedPerson(database.db);
    const c = await seedPerson(database.db);
    const expiredA = [await decide(a, 1), await decide(a, 2), await decide(a, 3)];
    const expiredB = [await decide(b, 1), await decide(b, 5)];
    const notYetExpired = await decide(a);
    // Expired, but ten days ago: past the pass's lookback, so it is left (a held decision never keeps the head of the scan).
    const tooOld = await decide(c, 10);
    // Expired and held by a live buffer: the buffer keeps it.
    await seedComposerBuffer(withScope(), b.authority);
    const heldByBuffer = (
      await sql<{
        decision_id: string;
      }>`select decision_id from composer.buffers where universe_id=${b.universeId}::uuid`.execute(database.db)
    ).rows[0]!.decision_id;
    await sql`update composer.decisions set recorded_at=now()-interval '31 days',expires_at=now()-interval '1 day' where id=${heldByBuffer}::uuid`.execute(
      database.db,
    );

    const result = await prune();
    expect(result).toEqual({ deleted: 5, universes: 2, failed: 0 });
    expect(await present(expiredA)).toEqual([]);
    expect(await present(expiredB)).toEqual([]);
    expect(await present([notYetExpired, tooOld, heldByBuffer])).toEqual([notYetExpired, tooOld, heldByBuffer].sort());
    // A second pass finds nothing left to delete.
    expect(await prune()).toEqual({ deleted: 0, universes: 0, failed: 0 });
  });

  it('never deletes a decision an offer holds, and deletes it from the others of the same universe', async () => {
    const cases = await scrollUseCases(database);
    try {
      const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
      source.assetId = randomUUID();
      source.publication.explanationUnitId = `ci-prune-${randomUUID()}`;
      const imported = await cases.importScroll(source);
      if (imported.kind !== 'imported') throw new Error('CI fixture refused');
      const person = await seedPerson(database.db);
      const navigation = await cases.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' },
        capabilities: textCapabilities,
      });
      if (navigation.kind !== 'accepted' || navigation.outcome.status !== 'ready')
        throw new Error('CI expected a ready offer');
      const held = navigation.outcome.decisionId;
      const loose = await decide(person, 2);
      await sql`update composer.decisions set recorded_at=now()-interval '31 days',expires_at=now()-interval '1 day' where id=${held}::uuid`.execute(
        database.db,
      );
      const result = await prune();
      expect(result.deleted).toBe(1);
      expect(await present([held, loose])).toEqual([held]);
      // The held decision is not found again either: the pass reads past it without looking at it.
      expect(await prune()).toEqual({ deleted: 0, universes: 0, failed: 0 });
    } finally {
      await cases.close();
    }
  });

  it('prunes a universe in bounded batches, so one large universe does not hold the pass', async () => {
    const person = await seedPerson(database.db);
    const ids: string[] = [];
    for (let n = 0; n < 6; n += 1) ids.push(await decide(person, 1));
    // `PRUNE_DECISIONS.batch` is far above six, so one pass takes them all; the store itself refuses an unbounded batch.
    await expect(withScope()(person.authority, (scope) => store.pruneComposerDecisions(scope, 5000))).rejects.toThrow(
      'COMPOSER_PRUNE_LIMIT',
    );
    expect((await prune()).deleted).toBe(6);
    expect(await present(ids)).toEqual([]);
  });

  it('leaves a universe at a newer privacy epoch alone instead of failing the pass', async () => {
    const stale = await seedPerson(database.db);
    const other = await seedPerson(database.db);
    const staleDecision = await decide(stale, 1);
    const otherDecision = await decide(other, 1);
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', stale.universeId)
      .execute();
    const result = await prune();
    expect(result.failed).toBe(0);
    expect(await present([otherDecision])).toEqual([]);
    // The old epoch's decision is the erasure's to remove; the pass refused the scope and moved on.
    expect(await present([staleDecision])).toEqual([staleDecision]);
  });
});
