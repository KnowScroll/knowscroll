import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeEnqueueInTransaction } from '@knowscroll/backend/infrastructure/jobs';
import { settleQuietQueue } from '@knowscroll/backend/modules/geography';
import { makeSettleQuiet, makeSweepQuiet, quietSweepStore } from '@knowscroll/backend/modules/geography/nest-providers';
import { recordingPolicyFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { projectSceneQueue } from '@knowscroll/backend/modules/scenes';
import type { CartographerPorts } from '@knowscroll/backend/modules/geography/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { gate, signal } from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { geographyWorld, topic, facet, otherFacet, type GeographyWorld } from '../support/geography-world.js';

/**
 * Places go quiet without new reading (#467, D-104). The scheduled sweep finds universes whose
 * stored `next_quiet_at` has passed and hands each to a rules-only settle. Reading, sources and
 * the Cartographer's model answers are authored CI fixtures; the sweep and the settle call no model.
 * "Days later" is the injected clock of the sweep and the settle; "long ago" is reading recorded
 * 40 days back and formed under a clock 39 days back, so the world really is old when the sweep runs.
 */
const DAY = 86_400_000;
const garbage: FixtureScenario = { kind: 'malformed' };

describe('the quiet sweep (real PostgreSQL CI fixtures)', () => {
  let world: GeographyWorld;
  beforeAll(async () => {
    world = await geographyWorld('quiet_sweep');
  });
  afterAll(() => world.close());

  const db = () => world.database.db;
  const daysFromNow = (days: number) => () => new Date(Date.now() + days * DAY);
  /** The sweep and the settle as the worker builds them, on a clock `days` ahead. */
  function atDay(days: number, enabled = () => true) {
    const now = daysFromNow(days);
    const store = quietSweepStore({ db: db(), enqueueInTransaction: makeEnqueueInTransaction(world.c.boss) });
    return {
      sweep: makeSweepQuiet({ enabled, now, store }),
      settle: makeSettleQuiet({ ...world.base, now, enabled }),
    };
  }
  const settleJob = (person: FixturePerson, recordingGeneration = 1) => ({
    v: 1 as const,
    universeId: person.universeId,
    privacyEpoch: 1,
    recordingGeneration,
  });
  async function jobsOf(person: FixturePerson) {
    return (
      await sql<{ data: unknown }>`select data from pgboss.job where name = ${settleQuietQueue.name}
        and data->>'universeId' = ${person.universeId} order by created_on`.execute(db())
    ).rows;
  }
  async function stateOf(person: FixturePerson) {
    return (
      await sql<{
        revision: number;
        structure_revision: number;
        activity_revision: number;
        next_quiet_at: Date | null;
      }>`select revision, structure_revision, activity_revision, next_quiet_at from geography.state
        where universe_id = ${person.universeId}::uuid`.execute(db())
    ).rows[0]!;
  }
  async function personalRevision(person: FixturePerson) {
    return (
      await db()
        .selectFrom('identity.universes')
        .select('revision')
        .where('id', '=', person.universeId)
        .executeTakeFirstOrThrow()
    ).revision;
  }
  /** Business runs and paid attempts of the person: a model call would add to either. */
  async function ledgerOf(person: FixturePerson) {
    const count = async (table: 'reasoning.business_runs' | 'reasoning.external_attempts') =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from ${sql.table(table)} where universe_id = ${person.universeId}::uuid`.execute(
          db(),
        )
      ).rows[0]!.n;
    return { runs: await count('reasoning.business_runs'), attempts: await count('reasoning.external_attempts') };
  }
  async function places(person: FixturePerson) {
    const universe = await world.snapshot(person);
    if (universe.status !== 'ready') throw new Error('CI ready expected');
    return [...universe.page.objects]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, kind, label, originTransitionId, activity }) => ({
        id,
        kind,
        label,
        originTransitionId,
        state: activity.availability === 'available' ? activity.state : 'unavailable',
      }));
  }
  const identityOf = (list: Awaited<ReturnType<typeof places>>) => list.map(({ state: _state, ...place }) => place);

  /** Runs the person's pending Cartographer run once; the fixture model answers nothing usable. */
  async function cartograph(person: FixturePerson, overrides?: Partial<CartographerPorts>) {
    const runId = (await world.state(person)).activeRunId;
    if (!runId) throw new Error('CI expected an active Cartographer run');
    const run = world.runner(person, () => garbage, overrides);
    await run.run(await world.job(person, runId), signal());
    return runId;
  }
  /** Three Scrolls read 40 days ago, formed by the Cartographer under a clock one day after that. */
  async function formedLongAgo(person: FixturePerson) {
    for (const facetId of [facet, otherFacet, facet])
      await world.observe(person, await world.fixture(undefined, topic, [facetId]), [], 40 * 24 * 60);
    await cartograph(person, { now: () => new Date(Date.now() - 39 * DAY) });
    return places(person);
  }
  const states = (list: Awaited<ReturnType<typeof places>>) => list.map((place) => place.state);
  /** Waits for a condition of the database itself, never for a fixed time. */
  async function until(condition: () => Promise<boolean>, what: string) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`CI timed out waiting for ${what}`);
  }
  /** Turns the person's recording off (generation 1 to 2) or on again (2 to 3). */
  function recording(person: FixturePerson) {
    const policy = recordingPolicyFor(db(), { lockTimeoutMs: 5000 });
    const set = (expectedRecordingGeneration: number, on: boolean) =>
      policy.set(person.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration,
        on,
      });
    return { pause: () => set(1, false), resume: () => set(2, true) };
  }

  it('turns every place quiet 31 days after the last reading, with the same ids, labels and origins', async () => {
    const person = await seedPerson(db());
    await world.coherent(person);
    await cartograph(person);
    const formed = await places(person);
    expect(formed).toHaveLength(5);
    expect(new Set(states(formed))).toEqual(new Set(['active']));
    const before = await stateOf(person);
    // The stored time is the thirtieth day after the newest reading.
    expect(before.next_quiet_at!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
    expect(before.next_quiet_at!.getTime()).toBeLessThan(Date.now() + 31 * DAY);
    const revisionBefore = await personalRevision(person);
    const ledgerBefore = await ledgerOf(person);

    // Before the thirtieth day nothing is due: no job, and a settle that runs anyway changes nothing.
    await atDay(29).sweep();
    expect(await jobsOf(person)).toEqual([]);
    expect(await atDay(0).settle(settleJob(person))).toEqual({ outcome: 'nothing_due', changed: 0 });
    expect(await stateOf(person)).toMatchObject({
      revision: before.revision,
      structure_revision: before.structure_revision,
      activity_revision: before.activity_revision,
    });
    expect(await personalRevision(person)).toBe(revisionBefore);
    // Without the sweep, time passing alone changes nothing: this is the gap D-104 closes.
    expect(new Set(states(await places(person)))).toEqual(new Set(['active']));

    // The sweep, 31 days on, hands the universe to exactly one settle, which makes the places quiet.
    const late = atDay(31);
    expect((await late.sweep()).handedOver).toBeGreaterThanOrEqual(1);
    const jobs = await jobsOf(person);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data).toEqual(settleJob(person));
    expect(await late.settle(jobs[0]!.data)).toEqual({ outcome: 'applied', changed: 5 });

    const quiet = await places(person);
    expect(identityOf(quiet)).toEqual(identityOf(formed));
    expect(new Set(states(quiet))).toEqual(new Set(['quiet']));
    // Only the activity stamps moved: one delta, no run, and the structure revision is untouched.
    const after = await stateOf(person);
    expect(after).toMatchObject({
      revision: before.revision + 1,
      structure_revision: before.structure_revision,
      activity_revision: before.revision + 1,
      next_quiet_at: null,
    });
    expect(await personalRevision(person)).toBe(revisionBefore + 1);
    const delta = (
      await sql<{ run_id: string | null; payload: { operations: { kind: string }[] } }>`select run_id, payload
        from geography.deltas where universe_id = ${person.universeId}::uuid and revision = ${after.revision}`.execute(
        db(),
      )
    ).rows[0]!;
    expect(delta.run_id).toBeNull();
    expect(delta.payload.operations.map((operation) => operation.kind)).toEqual(Array(5).fill('set_activity'));
    // Scenes are told through the ordinary projection job, stamped with the new activity revision.
    const projections = await sql<{ data: { geography: { activityRevision: number } } }>`select data from pgboss.job
      where name = ${projectSceneQueue.name} and data->>'universeId' = ${person.universeId}
      and (data->'geography'->>'activityRevision')::int = ${after.activity_revision}`.execute(db());
    expect(projections.rows).toHaveLength(1);
    // No model: nothing was added to the reasoning ledger.
    expect(await ledgerOf(person)).toEqual(ledgerBefore);

    // A second delivery, or another pass, finds nothing to do and moves no revision.
    expect(await late.settle(jobs[0]!.data)).toEqual({ outcome: 'nothing_due', changed: 0 });
    await late.sweep();
    expect(await jobsOf(person)).toHaveLength(1);
    expect(await stateOf(person)).toEqual(after);
    expect(await personalRevision(person)).toBe(revisionBefore + 1);
  });

  it('hands a universe over once while its settle waits, and again only when the lease ends', async () => {
    const person = await seedPerson(db());
    await formedLongAgo(person);
    const now = atDay(0);
    await now.sweep();
    await now.sweep();
    expect(await jobsOf(person)).toHaveLength(1);
    // The lease: the stored time moved about half an hour ahead, so the next pass does not see it.
    const leased = (await stateOf(person)).next_quiet_at!.getTime();
    expect(leased).toBeGreaterThan(Date.now() + 20 * 60_000);
    expect(leased).toBeLessThan(Date.now() + 40 * 60_000);
    // A settle job that was lost leaves the lease to run out; the sweep then hands the universe over again.
    await atDay(0.05).sweep();
    const jobs = await jobsOf(person);
    expect(jobs).toHaveLength(2);
    // The settle rewrites the lease: nothing left to quiet means no stored time.
    expect(await now.settle(jobs[0]!.data)).toEqual({ outcome: 'applied', changed: 5 });
    expect((await stateOf(person)).next_quiet_at).toBeNull();
  });

  it('hands over no universe that has nothing to settle', async () => {
    // One unit forms no place. Its Cartographer run is settled, so nothing is pending either.
    const dustOnly = await seedPerson(db());
    await world.observe(dustOnly, await world.fixture(undefined, topic, [facet]));
    await cartograph(dustOnly);
    expect((await world.state(dustOnly)).activeRunId).toBeUndefined();
    const idle = await stateOf(dustOnly);
    expect(idle.next_quiet_at).toBeNull();
    const fresh = await seedPerson(db());
    await world.coherent(fresh);
    await cartograph(fresh);

    await atDay(0).sweep();
    expect(await jobsOf(dustOnly)).toEqual([]);
    expect(await jobsOf(fresh)).toEqual([]);
    // 31 days on, the universe with places is due; the one with only dust has no place to quiet.
    await atDay(31).sweep();
    expect(await jobsOf(fresh)).toHaveLength(1);
    expect(await jobsOf(dustOnly)).toEqual([]);
    // The sweep did not even touch the dust-only universe's state.
    expect(await stateOf(dustOnly)).toEqual(idle);
  });

  it('lets a new encounter after quiet wake only the places it supports, as the Cartographer always did', async () => {
    const person = await seedPerson(db());
    const formed = await formedLongAgo(person);
    expect(new Set(states(formed))).toEqual(new Set(['active']));
    // The world is old: the first real-clock sweep finds it due.
    const now = atDay(0);
    await now.sweep();
    const [job] = await jobsOf(person);
    expect(await now.settle(job!.data)).toEqual({ outcome: 'applied', changed: 5 });
    expect(new Set(states(await places(person)))).toEqual(new Set(['quiet']));

    await world.observe(person, await world.fixture(undefined, topic, [facet]));
    await cartograph(person);
    const woken = await places(person);
    expect(identityOf(woken)).toEqual(identityOf(formed));
    expect(states(woken).filter((state) => state === 'active')).toHaveLength(4);
    expect(woken.filter((place) => place.state === 'quiet').map((place) => place.kind)).toEqual(['region']);
    // The next look is a month after the new reading.
    expect((await stateOf(person)).next_quiet_at!.getTime()).toBeGreaterThan(Date.now() + 29 * DAY);
  });

  it('never settles under a Cartographer run, and the run still applies afterwards', async () => {
    const person = await seedPerson(db());
    await formedLongAgo(person);
    await world.observe(person, await world.fixture(undefined, topic, [facet]));
    const runId = (await world.state(person)).activeRunId!;
    const before = await stateOf(person);

    await atDay(0).sweep();
    expect(await jobsOf(person)).toEqual([]);
    // The sweep only moves its own scheduling time, a day ahead, so the universe leaves the head of the index.
    const held = await stateOf(person);
    expect(held).toMatchObject({ revision: before.revision, activity_revision: before.activity_revision });
    expect(held.next_quiet_at!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // A settle that was already queued stands aside rather than move the revision under the run.
    expect(await atDay(0).settle(settleJob(person))).toEqual({ outcome: 'run_active', changed: 0 });
    expect(await stateOf(person)).toEqual(held);

    expect(await cartograph(person)).toBe(runId);
    const run = await db()
      .selectFrom('geography.runs')
      .select(['status', 'outcome'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    expect(run).toMatchObject({ status: 'accepted' });
    expect((await stateOf(person)).revision).toBe(held.revision + 1);
  });

  it('waits for the personal root, then settles once', async () => {
    const person = await seedPerson(db());
    await formedLongAgo(person);
    // The test holds the personal root from one transaction and starts the settle outside it.
    const entered = gate();
    const release = gate();
    const holding = world.scope()(person.authority, async () => {
      entered.open();
      await release.promise;
    });
    await entered.promise;
    let finished = false;
    const pending = atDay(0)
      .settle(settleJob(person))
      .then((result) => {
        finished = true;
        return result;
      });
    // The settle is blocked on the root: a backend waits for a row lock, so it cannot have finished.
    await until(
      async () =>
        (
          await sql<{ n: number }>`select count(*)::int as n from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock' and query ilike '%universes%'`.execute(db())
        ).rows[0]!.n > 0,
      'the settle to wait for the personal root',
    );
    expect(finished).toBe(false);
    release.open();
    await holding;
    expect(await pending).toEqual({ outcome: 'applied', changed: 5 });
    expect(new Set(states(await places(person)))).toEqual(new Set(['quiet']));
  });

  it('leaves a paused universe exactly as it was, and settles it within a day of recording being back on', async () => {
    const person = await seedPerson(db());
    const formed = await formedLongAgo(person);
    const { pause, resume } = recording(person);
    await pause();
    const paused = await stateOf(person);

    await atDay(0).sweep();
    expect(await jobsOf(person)).toEqual([]);
    // No place, delta or revision moved. The sweep only parked its own scheduling time a day ahead.
    const parked = await stateOf(person);
    expect(parked).toMatchObject({
      revision: paused.revision,
      structure_revision: paused.structure_revision,
      activity_revision: paused.activity_revision,
    });
    expect(parked.next_quiet_at!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await atDay(0).settle(settleJob(person))).toEqual({ outcome: 'not_current', changed: 0 });
    expect(await stateOf(person)).toEqual(parked);
    expect(states(await places(person))).toEqual(states(formed));

    await resume();
    // Before the parked time the sweep leaves it; once that has passed it hands the universe over.
    await atDay(0).sweep();
    expect(await jobsOf(person)).toEqual([]);
    const nextDay = atDay(2);
    await nextDay.sweep();
    const jobs = await jobsOf(person);
    expect(jobs.map((job) => job.data)).toEqual([settleJob(person, 3)]);
    // The old generation's payload is refused; the current one settles.
    expect(await nextDay.settle(settleJob(person))).toEqual({ outcome: 'not_current', changed: 0 });
    expect(await nextDay.settle(jobs[0]!.data)).toEqual({ outcome: 'applied', changed: 5 });
    expect(new Set(states(await places(person)))).toEqual(new Set(['quiet']));
  });

  it('does nothing while the Cartographer is switched off', async () => {
    const person = await seedPerson(db());
    await formedLongAgo(person);
    const before = await stateOf(person);
    const off = atDay(0, () => false);
    expect(await off.sweep()).toEqual({ handedOver: 0 });
    expect(await jobsOf(person)).toEqual([]);
    expect(await off.settle(settleJob(person))).toEqual({ outcome: 'disabled', changed: 0 });
    expect(await stateOf(person)).toEqual(before);
  });

  it('erases queued settles with the universe, and refuses a payload from an earlier epoch', async () => {
    const person = await seedPerson(db());
    await formedLongAgo(person);
    const now = atDay(0);
    await now.sweep();
    expect(await jobsOf(person)).toHaveLength(1);

    await db()
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    await world.scope()({ ...person.authority, privacyEpoch: 2 }, (scope) => eraseUniverse(scope, personalStores));
    expect(await jobsOf(person)).toEqual([]);
    expect(
      (
        await sql<{ n: number }>`select count(*)::int as n from geography.state
          where universe_id = ${person.universeId}::uuid`.execute(db())
      ).rows[0]!.n,
    ).toBe(0);
    expect(await now.settle(settleJob(person))).toEqual({ outcome: 'not_current', changed: 0 });
  });

  it('keeps refused universes from crowding the head of the index', async () => {
    const store = quietSweepStore({ db: db(), enqueueInTransaction: makeEnqueueInTransaction(world.c.boss) });
    const pass = (limit: number) => {
      const now = new Date();
      return store.handOverDue({
        now,
        limit,
        leaseUntil: new Date(now.getTime() + 30 * 60_000),
        parkUntil: new Date(now.getTime() + DAY),
      });
    };
    // Whatever earlier tests left due is leased or parked first, so only this test's universes are at the head.
    await pass(10_000);
    // Two paused universes are due before a third that can be settled, and a pass looks at two.
    const refused = [await seedPerson(db()), await seedPerson(db())];
    for (const person of refused) {
      await formedLongAgo(person);
      await recording(person).pause();
    }
    const settleable = await seedPerson(db());
    await formedLongAgo(settleable);

    expect(await pass(2)).toBe(0);
    expect(await jobsOf(settleable)).toEqual([]);
    for (const person of refused)
      expect((await stateOf(person)).next_quiet_at!.getTime()).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    // They left the head, so the next pass of the same size reaches the universe that can be settled.
    expect(await pass(2)).toBe(1);
    expect(await jobsOf(settleable)).toHaveLength(1);
    for (const person of refused) expect(await jobsOf(person)).toEqual([]);
  });
});
