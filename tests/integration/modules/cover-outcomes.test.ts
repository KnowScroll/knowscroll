import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeWithPersonalScope, type Database } from '@knowscroll/backend/infrastructure/postgres';
import { releaseQueues } from '@knowscroll/backend/job-queues';
import {
  PRUNE_COVER_OUTCOMES,
  pruneCoverOutcomesQueue,
  type PruneCoverOutcomes,
} from '@knowscroll/backend/modules/experience';
import { coverOutcomesPruneProviders } from '@knowscroll/backend/modules/experience/nest-providers';
import type { CoverPass, EncounterOffer, NavigationOutcome } from '@knowscroll/contracts';
import { createTestDatabase, type TestDatabase } from '../support/database.js';
import { buildFromProviders } from '../support/providers.js';
import { pauseAndResume, recordingPerson, setRecording } from '../support/recording-person.js';
import { scrollUseCases, starterSource, textCapabilities } from '../support/scroll.js';
import type { FixturePerson } from '../support/fixtures.js';

/**
 * Cover outcomes (#748, `experience.cover_outcomes`) on real PostgreSQL: what a pass or an opened cover stores, when it is
 * dropped, how the cover time is clamped, that none of it is activity, the more-covers request, and the 30-day sweep.
 * Evidence label: CI fixture accounts and labelled fixture Scrolls, real database.
 */
type Cases = Awaited<ReturnType<typeof scrollUseCases>>;
type Ready = Extract<NavigationOutcome, { status: 'ready' }>;

const DATABASE = Symbol('test.database');
const SCOPE = Symbol('test.withPersonalScope');
const DAY_MS = 86_400_000;

function ready(result: Awaited<ReturnType<Cases['navigate']>>): Ready {
  if (result.kind !== 'accepted' || result.outcome.status !== 'ready')
    throw new Error(`CI fixture expected ready, got ${JSON.stringify(result)}`);
  return result.outcome;
}
const handOf = (outcome: Ready): EncounterOffer[] => [outcome.offer, ...outcome.bufferedOffers];
const passOf = (
  offer: EncounterOffer,
  onScreen: CoverPass['onScreen'] = '1_5s_to_5s',
  way: CoverPass['way'] = 'more_covers',
) => ({
  offerId: offer.offerId,
  onScreen,
  way,
});

async function seedScrolls(c: Cases, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const source = starterSource() as { assetId: string; publication: { explanationUnitId: string } };
    source.assetId = randomUUID();
    source.publication.explanationUnitId = `fixture-cover-outcomes-${randomUUID()}`;
    const imported = await c.importScroll(source);
    if (imported.kind !== 'imported') throw new Error('fixture admission refused');
    ids.push(imported.assetId);
  }
  return ids;
}

/** The commands a person's client sends, over one database and one fixture graph. */
function world(database: TestDatabase<Database>, c: Cases) {
  const rowsOf = (universeId: string) =>
    sql<{
      offer_id: string;
      asset_id: string;
      outcome: string;
      on_screen: string | null;
      way: string | null;
      cover_ms: number | null;
      recorded_at: Date;
      expires_at: Date;
      created_at: Date;
    }>`select c.offer_id, c.asset_id, c.outcome, c.on_screen, c.way, c.cover_ms, c.recorded_at, c.expires_at, o.created_at
      from experience.cover_outcomes c join experience.offers o on o.universe_id = c.universe_id and o.id = c.offer_id
      where c.universe_id = ${universeId}::uuid order by c.offer_id`
      .execute(database.db)
      .then((result) => result.rows);
  return {
    rowsOf,
    open: async (person: FixturePerson, extra: { recordingGeneration?: number } = {}) =>
      ready(
        await c.navigate(person.authority, {
          commandId: randomUUID(),
          target: { kind: 'discover' as const },
          capabilities: textCapabilities,
          ...extra,
        }),
      ),
    /** "More covers": the next hand of the session, after the one that `hand` dealt. */
    more: (
      person: FixturePerson,
      hand: Ready,
      extra: { passes?: CoverPass[]; recordingGeneration?: number; decisionId?: string; revision?: number } = {},
    ) =>
      c.navigate(person.authority, {
        commandId: randomUUID(),
        target: { kind: 'discover' as const },
        session: { sessionId: hand.sessionId, expectedIntentRevision: extra.revision ?? hand.intentRevision },
        capabilities: textCapabilities,
        after: { decisionId: extra.decisionId ?? hand.decisionId, format: 'scroll' as const },
        ...(extra.passes ? { passes: extra.passes } : {}),
        ...(extra.recordingGeneration === undefined ? {} : { recordingGeneration: extra.recordingGeneration }),
      }),
    activate: (
      person: FixturePerson,
      hand: Ready,
      offer: EncounterOffer,
      extra: { coverMs?: number; passes?: CoverPass[]; recordingGeneration?: number; commandId?: string } = {},
    ) =>
      c.activateOffer(person.authority, {
        commandId: extra.commandId ?? randomUUID(),
        target: {
          kind: 'offer' as const,
          sessionId: hand.sessionId,
          offerId: offer.offerId,
          expectedIntentRevision: hand.intentRevision,
        },
        ...(extra.coverMs === undefined ? {} : { coverMs: extra.coverMs }),
        ...(extra.passes ? { passes: extra.passes } : {}),
        ...(extra.recordingGeneration === undefined ? {} : { recordingGeneration: extra.recordingGeneration }),
      }),
    /** Makes an offer look `seconds` old, so a cover time has room to be kept; its 15-minute life moves with it (a CHECK). */
    age: (universeId: string, offerId: string, seconds: number) =>
      sql`update experience.offers set created_at = now() - make_interval(secs => ${seconds}::int),
          expires_at = now() - make_interval(secs => ${seconds}::int) + interval '15 minutes'
        where universe_id = ${universeId}::uuid and id = ${offerId}::uuid`.execute(database.db),
    /** What would make a report activity or evidence: exposures, recording segments, evidence sessions, their jobs. */
    footprint: async (universeId: string) => {
      const count = async (query: ReturnType<typeof sql<{ n: number }>>) =>
        (await query.execute(database.db)).rows[0]?.n;
      return {
        exposures: await count(
          sql<{
            n: number;
          }>`select count(*)::int as n from experience.exposures where universe_id = ${universeId}::uuid`,
        ),
        segments: await count(
          sql<{
            n: number;
          }>`select count(*)::int as n from experience.recording_segments where universe_id = ${universeId}::uuid`,
        ),
        evidenceSessions: await count(
          sql<{
            n: number;
          }>`select count(*)::int as n from evidence.recording_sessions where universe_id = ${universeId}::uuid`,
        ),
        jobs: await count(
          sql<{ n: number }>`select count(*)::int as n from pgboss.job
            where (name like 'evidence.%' or name like 'experience.%') and data ->> 'universeId' = ${universeId}`,
        ),
      };
    },
  };
}

describe('cover outcomes (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Cases, w: ReturnType<typeof world>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('cover_outcomes');
    c = await scrollUseCases(database, { recording: true });
    await seedScrolls(c, 9);
    w = world(database, c);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  describe('passes while recording is on', () => {
    it('stores one passed row per reported offer, with its band, way, asset and a 30-day expiry', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      const hand = handOf(first);
      expect(hand.length).toBeGreaterThan(1);
      const reported = [passOf(hand[0]!, 'under_1_5s', 'next_cover'), passOf(hand[1]!, 'over_5s', 'left')];
      const second = ready(await w.more(p, first, { passes: reported }));
      expect(second.sessionId).toBe(first.sessionId);

      const rows = await w.rowsOf(p.universeId);
      expect(rows).toHaveLength(2);
      for (const [index, pass] of reported.entries()) {
        const row = rows.find((candidate) => candidate.offer_id === pass.offerId);
        expect(row).toMatchObject({
          asset_id: hand[index]!.assetId,
          outcome: 'passed',
          on_screen: pass.onScreen,
          way: pass.way,
          cover_ms: null,
        });
        // The database's own bound: exactly thirty days from the moment it was recorded, and about thirty days from now.
        expect(row!.expires_at.getTime() - row!.recorded_at.getTime()).toBe(30 * DAY_MS);
        expect(Math.abs(row!.expires_at.getTime() - (Date.now() + 30 * DAY_MS))).toBeLessThan(5 * 60_000);
      }
    });

    it('does not store a pass for an offer that was already opened, and keeps the one for its sibling', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      const [opened, sibling] = handOf(first);
      expect(sibling).toBeDefined();
      expect(await w.activate(p, first, opened!)).toMatchObject({ kind: 'accepted' });
      const more = await w.more(p, first, { passes: [passOf(opened!), passOf(sibling!)] });
      expect(more.kind).toBe('accepted');
      expect((await w.rowsOf(p.universeId)).map((row) => row.offer_id)).toEqual([sibling!.offerId]);
    });

    it("stores nothing for another person's offer, and does not touch that person's rows", async () => {
      const p = await recordingPerson(database);
      const other = await recordingPerson(database);
      const mine = await w.open(p);
      const theirs = await w.open(other);
      const result = await w.more(p, mine, { passes: [passOf(handOf(theirs)[0]!)] });
      expect(result.kind).toBe('accepted');
      expect(await w.rowsOf(p.universeId)).toEqual([]);
      expect(await w.rowsOf(other.universeId)).toEqual([]);
    });

    it('stores a pass reported by an activation too, for the other offers of the hand', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      const [opened, passed] = handOf(first);
      expect(
        await w.activate(p, first, opened!, { passes: [passOf(passed!, 'over_5s', 'next_cover'), passOf(opened!)] }),
      ).toMatchObject({ kind: 'accepted' });
      // The offer being opened is never reported as passed by its own activation.
      expect(await w.rowsOf(p.universeId)).toMatchObject([
        { offer_id: passed!.offerId, outcome: 'passed', on_screen: 'over_5s', way: 'next_cover' },
      ]);
    });
  });

  describe('recording paused', () => {
    it('drops passes and the cover time, and the commands still succeed', async () => {
      const p = await recordingPerson(database);
      await setRecording(database, p, 1, false);
      const first = await w.open(p, { recordingGeneration: 2 });
      const [opened, passed] = handOf(first);
      await w.age(p.universeId, opened!.offerId, 30);
      expect(
        await w.activate(p, first, opened!, { coverMs: 2000, passes: [passOf(passed!)], recordingGeneration: 2 }),
      ).toMatchObject({ kind: 'accepted', outcome: { replayed: false } });
      const more = await w.more(p, first, { passes: [passOf(passed!)], recordingGeneration: 2 });
      expect(more.kind).toBe('accepted');
      expect(await w.rowsOf(p.universeId)).toEqual([]);
    });

    it('drops a pass for an offer made at an earlier recording generation, after a pause and a resume', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      await pauseAndResume(database, p);
      const more = await w.more(p, first, { passes: handOf(first).map((offer) => passOf(offer)) });
      expect(more.kind).toBe('accepted');
      expect(await w.rowsOf(p.universeId)).toEqual([]);

      // The same for an opened cover: the offer was made at generation 1, the activation happens at 3.
      const q = await recordingPerson(database);
      const dealt = await w.open(q);
      await pauseAndResume(database, q);
      await w.age(q.universeId, dealt.offer.offerId, 30);
      expect(await w.activate(q, dealt, dealt.offer, { coverMs: 2000 })).toMatchObject({ kind: 'accepted' });
      expect(await w.rowsOf(q.universeId)).toEqual([]);
    });
  });

  describe('the cover time of an activation', () => {
    it('clamps a huge value to the time since the offer was made, on the database clock', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      expect(await w.activate(p, first, first.offer, { coverMs: 900_000 })).toMatchObject({ kind: 'accepted' });
      const [row, ...rest] = await w.rowsOf(p.universeId);
      expect(rest).toEqual([]);
      expect(row).toMatchObject({ offer_id: first.offer.offerId, asset_id: first.offer.assetId, outcome: 'opened' });
      expect(row!.on_screen).toBeNull();
      expect(row!.way).toBeNull();
      const elapsed = row!.recorded_at.getTime() - row!.created_at.getTime();
      expect(row!.cover_ms).toBeGreaterThanOrEqual(0);
      expect(row!.cover_ms!).toBeLessThanOrEqual(elapsed);
      expect(row!.cover_ms!).toBeLessThan(900_000);
      expect(row!.expires_at.getTime() - row!.recorded_at.getTime()).toBe(30 * DAY_MS);
    });

    it('keeps a plausible value as sent', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      await w.age(p.universeId, first.offer.offerId, 30);
      expect(await w.activate(p, first, first.offer, { coverMs: 2000 })).toMatchObject({ kind: 'accepted' });
      expect(await w.rowsOf(p.universeId)).toMatchObject([{ outcome: 'opened', cover_ms: 2000 }]);
    });

    it('writes nothing without a cover time', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      expect(await w.activate(p, first, first.offer)).toMatchObject({ kind: 'accepted' });
      expect(await w.rowsOf(p.universeId)).toEqual([]);
    });

    it('writes once: a replay, and another command on the same offer, change nothing', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      await w.age(p.universeId, first.offer.offerId, 30);
      const commandId = randomUUID();
      expect(await w.activate(p, first, first.offer, { coverMs: 2000, commandId })).toMatchObject({ kind: 'accepted' });
      const [written] = await w.rowsOf(p.universeId);
      expect(written).toMatchObject({ outcome: 'opened', cover_ms: 2000 });

      const replay = await w.activate(p, first, first.offer, { coverMs: 7000, commandId });
      expect(replay).toMatchObject({ kind: 'accepted', outcome: { replayed: true } });
      const another = await w.activate(p, first, first.offer, { coverMs: 9000 });
      expect(another).toMatchObject({ kind: 'accepted' });
      expect(await w.rowsOf(p.universeId)).toEqual([written]);
    });

    it('turns an earlier pass of the same offer into the open, and never the other way', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      const [opened, passed] = handOf(first);
      expect(await w.activate(p, first, opened!, { passes: [passOf(passed!, 'over_5s', 'next_cover')] })).toMatchObject(
        {
          kind: 'accepted',
        },
      );
      expect(await w.rowsOf(p.universeId)).toMatchObject([{ offer_id: passed!.offerId, outcome: 'passed' }]);

      await w.age(p.universeId, passed!.offerId, 30);
      expect(await w.activate(p, first, passed!, { coverMs: 2500 })).toMatchObject({ kind: 'accepted' });
      const rows = await w.rowsOf(p.universeId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        offer_id: passed!.offerId,
        outcome: 'opened',
        on_screen: null,
        way: null,
        cover_ms: 2500,
      });

      // Reporting the pass again, now that the offer is open, leaves the open as it is.
      const again = await w.more(p, first, { passes: [passOf(passed!)] });
      expect(again.kind).toBe('accepted');
      expect(await w.rowsOf(p.universeId)).toEqual(rows);
    });
  });

  describe('a pass is not activity', () => {
    it('creates no exposure, no recording segment, no evidence session and no evidence or activity job', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      const before = await w.footprint(p.universeId);
      expect(before).toEqual({ exposures: 0, segments: 0, evidenceSessions: 0, jobs: 0 });

      expect(await w.more(p, first, { passes: handOf(first).map((offer) => passOf(offer)) })).toMatchObject({
        kind: 'accepted',
      });
      expect(await w.rowsOf(p.universeId)).toHaveLength(handOf(first).length);
      expect(await w.footprint(p.universeId)).toEqual(before);

      // The check can see a footprint: opening one does leave one.
      const q = await recordingPerson(database);
      const dealt = await w.open(q);
      expect(await w.activate(q, dealt, dealt.offer, { coverMs: 100 })).toMatchObject({ kind: 'accepted' });
      const after = await w.footprint(q.universeId);
      expect(after.exposures).toBe(1);
      expect(after.segments).toBeGreaterThan(0);
    });
  });

  describe('more covers', () => {
    it('refuses an `after` that is not the session’s latest decision', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      expect(await w.more(p, first, { decisionId: randomUUID() })).toMatchObject({
        kind: 'refused',
        code: 'INTENT_REVISION_STALE',
      });
      // Nothing was dealt by the refused request: the real one still works, and the old hand is now stale.
      const second = ready(await w.more(p, first));
      expect(await w.more(p, first, { revision: second.intentRevision })).toMatchObject({
        kind: 'refused',
        code: 'INTENT_REVISION_STALE',
      });
    });

    it('deals another hand with no source, in the named format, leaving out every asset dealt and not opened', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      const second = ready(await w.more(p, first));
      const third = ready(await w.more(p, second));
      const dealtBefore = new Set(handOf(first).map((offer) => offer.assetId));
      for (const offer of handOf(second)) expect(dealtBefore.has(offer.assetId)).toBe(false);
      const dealtTwice = new Set([...dealtBefore, ...handOf(second).map((offer) => offer.assetId)]);
      for (const offer of handOf(third)) expect(dealtTwice.has(offer.assetId)).toBe(false);

      for (const offer of [...handOf(second), ...handOf(third)]) {
        expect(offer.metadata.kind).toBe('scroll');
        expect(offer.relation).toEqual({ kind: 'discovery' });
      }
      const stored = await database.db
        .selectFrom('experience.offers')
        .select(['source_offer_id', 'source_exposure_id', 'session_id'])
        .where('universe_id', '=', p.universeId)
        .execute();
      expect(stored.length).toBe(handOf(first).length + handOf(second).length + handOf(third).length);
      for (const row of stored) {
        expect(row.source_offer_id).toBeNull();
        expect(row.source_exposure_id).toBeNull();
        expect(row.session_id).toBe(first.sessionId);
      }
    });

    it('replays the same more-covers command as it was, with the same hand', async () => {
      const p = await recordingPerson(database);
      const first = await w.open(p);
      const command = {
        commandId: randomUUID(),
        target: { kind: 'discover' as const },
        session: { sessionId: first.sessionId, expectedIntentRevision: first.intentRevision },
        capabilities: textCapabilities,
        after: { decisionId: first.decisionId, format: 'scroll' as const },
        passes: [passOf(first.offer)],
      };
      const one = ready(await c.navigate(p.authority, command));
      const two = ready(await c.navigate(p.authority, command));
      expect(two.replayed).toBe(true);
      expect(handOf(two).map((offer) => offer.offerId)).toEqual(handOf(one).map((offer) => offer.offerId));
      expect(await w.rowsOf(p.universeId)).toHaveLength(1);
    });
  });
});

describe('more covers over a small catalogue (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Cases, w: ReturnType<typeof world>;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('cover_outcomes_small');
    c = await scrollUseCases(database, { recording: true });
    await seedScrolls(c, 3);
    w = world(database, c);
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  it('has nothing left to deal when every Scroll was dealt and none opened', async () => {
    const p = await recordingPerson(database);
    const first = await w.open(p);
    expect(handOf(first)).toHaveLength(3);
    const next = await w.more(p, first);
    expect(next).toMatchObject({ kind: 'accepted', outcome: { status: 'exhausted' } });
  });

  it('does not leave out an asset that was opened: it may be dealt again, the unopened ones may not', async () => {
    const p = await recordingPerson(database);
    const first = await w.open(p);
    const [opened, ...unopened] = handOf(first);
    expect(await w.activate(p, first, opened!)).toMatchObject({ kind: 'accepted' });
    const next = ready(await w.more(p, first));
    expect(handOf(next).map((offer) => offer.assetId)).toEqual([opened!.assetId]);
    for (const offer of unopened) expect(handOf(next).map((item) => item.assetId)).not.toContain(offer.assetId);
  });
});

describe('the scheduled cover-outcome sweep (real PostgreSQL, labelled CI fixtures)', () => {
  let database: TestDatabase<Database>, c: Cases, w: ReturnType<typeof world>;
  let prune: PruneCoverOutcomes;

  beforeAll(async () => {
    database = await createTestDatabase<Database>('cover_outcomes_prune');
    c = await scrollUseCases(database, { recording: true });
    await seedScrolls(c, 6);
    w = world(database, c);
    prune = buildFromProviders(
      coverOutcomesPruneProviders({ database: DATABASE, withPersonalScope: SCOPE }),
      PRUNE_COVER_OUTCOMES,
      new Map<symbol, unknown>([
        [DATABASE, database.db],
        [SCOPE, makeWithPersonalScope(database.db, { lockTimeoutMs: 5_000 })],
      ]),
    ) as PruneCoverOutcomes;
  });
  afterAll(async () => {
    await c.close();
    await database.drop();
  });

  /** One person with two passed covers, `expired` of them made to be past their 30 days. */
  async function personWithPasses(expired: number) {
    const p = await recordingPerson(database);
    const first = await w.open(p);
    const hand = handOf(first).slice(0, 2);
    ready(await w.more(p, first, { passes: hand.map((offer) => passOf(offer)) }));
    for (const offer of hand.slice(0, expired))
      // Recorded 31 days ago, expiring a day ago: the table's CHECK allows exactly a 30-day life.
      await sql`update experience.cover_outcomes set recorded_at = now() - interval '31 days', expires_at = now() - interval '1 day'
        where universe_id = ${p.universeId}::uuid and offer_id = ${offer.offerId}::uuid`.execute(database.db);
    return { p, hand };
  }
  const idsOf = async (universeId: string) => (await w.rowsOf(universeId)).map((row) => row.offer_id).sort();

  it('is a declared release queue on a schedule at its own minute, with no payload that names a person', () => {
    expect(releaseQueues.map((queue) => queue.name)).toContain(pruneCoverOutcomesQueue.name);
    expect(pruneCoverOutcomesQueue.schedule).toEqual({ cron: '22,52 * * * *', payload: { v: 1 } });
    expect(pruneCoverOutcomesQueue.payload.safeParse({ v: 1 }).success).toBe(true);
    expect(pruneCoverOutcomesQueue.payload.safeParse({ v: 1, universeId: randomUUID() }).success).toBe(false);
  });

  it('deletes expired rows of every universe that has some, keeps fresh ones, and a second run finds nothing', async () => {
    const a = await personWithPasses(1);
    const b = await personWithPasses(2);
    const c2 = await personWithPasses(0);
    const expect2 = {
      a: [a.hand[1]!.offerId],
      b: [] as string[],
      c: [c2.hand[0]!.offerId, c2.hand[1]!.offerId].sort(),
    };

    expect(await prune()).toEqual({ deleted: 3, universes: 2, failed: 0 });
    expect(await idsOf(a.p.universeId)).toEqual(expect2.a);
    expect(await idsOf(b.p.universeId)).toEqual(expect2.b);
    expect(await idsOf(c2.p.universeId)).toEqual(expect2.c);
    expect(await prune()).toEqual({ deleted: 0, universes: 0, failed: 0 });
    expect(await idsOf(c2.p.universeId)).toEqual(expect2.c);
  });

  it('deletes only what is expired, in the universe it entered', async () => {
    const own = await personWithPasses(1);
    const bystander = await personWithPasses(0);
    const before = await w.rowsOf(bystander.p.universeId);
    await prune();
    expect(await idsOf(own.p.universeId)).toEqual([own.hand[1]!.offerId]);
    expect(await w.rowsOf(bystander.p.universeId)).toEqual(before);
  });

  it('leaves a universe the root refuses alone and still sweeps the others', async () => {
    const gone = await personWithPasses(2);
    const live = await personWithPasses(2);
    // A new privacy epoch is refused by the personal root (Clear removes the rows itself; this one is a stale fixture).
    await sql`update identity.universes set privacy_epoch = privacy_epoch + 1 where id = ${gone.p.universeId}::uuid`.execute(
      database.db,
    );
    const result = await prune();
    expect(result.failed).toBe(0);
    expect(await idsOf(live.p.universeId)).toEqual([]);
    expect(await idsOf(gone.p.universeId)).toHaveLength(2);
  });
});
