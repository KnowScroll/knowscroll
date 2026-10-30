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
        }>`select count(*)::int as n from ${sql.table(table)} where universe_id = ${person.universeId}::uuid`.execute(db())
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
  const identityOf = (list: Awaited<ReturnType<typeof places>>) =>
    list.map(({ state: _state, ...place }) => place);

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

  it('hands over no universe that has nothing to settle', async () => {
    const dustOnly = await seedPerson(db());
    await world.observe(dustOnly, await world.fixture(undefined, topic, [facet]));
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
    const held = await stateOf(person);

    await atDay(0).sweep();
    expect(await jobsOf(person)).toEqual([]);
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
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(finished).toBe(false);
    release.open();
    await holding;
    expect(await pending).toEqual({ outcome: 'applied', changed: 5 });
    expect(new Set(states(await places(person)))).toEqual(new Set(['quiet']));
  });

  it('leaves a paused universe exactly as it was, and settles it once recording is back on', async () => {
    const person = await seedPerson(db());
    const formed = await formedLongAgo(person);
    const policy = recordingPolicyFor(db(), { lockTimeoutMs: 5000 });
    const set = (expectedRecordingGeneration: number, on: boolean) =>
      policy.set(person.authority, {
        version: 'recording-policy.v1',
        commandId: randomUUID(),
        expectedPrivacyEpoch: 1,
        expectedRecordingGeneration,
        on,
      });
    await set(1, false);
    const paused = await stateOf(person);

    await atDay(0).sweep();
    expect(await jobsOf(person)).toEqual([]);
    expect(await atDay(0).settle(settleJob(person))).toEqual({ outcome: 'not_current', changed: 0 });
    expect(await stateOf(person)).toEqual(paused);
    expect(states(await places(person))).toEqual(states(formed));

    await set(2, true);
    const now = atDay(0);
    await now.sweep();
    const jobs = await jobsOf(person);
    expect(jobs.map((job) => job.data)).toEqual([settleJob(person, 3)]);
    // The old generation's payload is refused; the current one settles.
    expect(await now.settle(settleJob(person))).toEqual({ outcome: 'not_current', changed: 0 });
    expect(await now.settle(jobs[0]!.data)).toEqual({ outcome: 'applied', changed: 5 });
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

    await db().updateTable('identity.universes').set({ privacy_epoch: 2 }).where('id', '=', person.universeId).execute();
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
});
