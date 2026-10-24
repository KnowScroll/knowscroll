import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { makeRunCartographer } from '@knowscroll/backend/modules/geography/nest-providers';
import { reasoningOperatorFor } from '@knowscroll/backend/reasoning/nest-providers';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { fixtureSettings, gate, signal, silent } from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { geographyWorld, topic, facet, otherFacet, type GeographyWorld } from '../support/geography-world.js';

/**
 * How the Cartographer behaves while reading keeps arriving (#231, D-052): one pending run, a
 * valid answer applied unless authority changed, no model call without a place due, and a run that
 * budget refuses ending honestly. Sources and model answers are authored CI fixtures.
 */
describe('Cartographer runs under continuous reading (real PostgreSQL CI fixtures)', () => {
  let world: GeographyWorld;
  beforeAll(async () => {
    world = await geographyWorld('cartographer_churn');
  });
  afterAll(() => world.close());

  const runsOf = (person: FixturePerson) =>
    world.database.db
      .selectFrom('geography.runs')
      .select(['id', 'status', 'outcome'])
      .where('universe_id', '=', person.universeId)
      .orderBy('id')
      .execute();
  const ledgerOf = async (person: FixturePerson) =>
    (
      await world.database.db
        .selectFrom('reasoning.business_runs')
        .select(['id', 'state'])
        .where('universe_id', '=', person.universeId)
        .execute()
    ).map((run) => run.state);
  const placeKinds = async (person: FixturePerson) => {
    const universe = await world.snapshot(person);
    return 'page' in universe ? universe.page.objects.map((place) => place.kind).sort() : [];
  };
  /** The ordinary wake of a run: its pg-boss job and when it may start. */
  async function wakeOf(person: FixturePerson, runId: string) {
    const row = await world.database.db
      .selectFrom('geography.runs')
      .select('normal_wake_id')
      .where('universe_id', '=', person.universeId)
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
    const job = (
      await sql<{
        start_after: Date;
      }>`select start_after from pgboss.job where id = ${row.normal_wake_id}::uuid`.execute(world.database.db)
    ).rows[0];
    return { wakeId: row.normal_wake_id, startAfter: job?.start_after };
  }
  /** Holds the model call of the person's active run open, and says when it is in flight. */
  async function holdingRun(person: FixturePerson) {
    const answer = gate<FixtureScenario>();
    let frozen!: Parameters<NonNullable<Parameters<typeof world.runner>[1]>>[0];
    let inFlight!: () => void;
    const flying = new Promise<void>((resolve) => {
      inFlight = resolve;
    });
    const runId = (await world.state(person)).activeRunId!;
    const run = world.runner(person, (context) => {
      frozen = context;
      inFlight();
      return { kind: 'hold', until: answer.promise };
    });
    const finished = run.run(await world.job(person, runId), signal());
    await flying;
    return { runId, run, frozen: () => frozen, answer: (scenario: FixtureScenario) => answer.open(scenario), finished };
  }

  it('turns a burst of reading into one pending run, and applies the answer that was in flight while more arrived', async () => {
    const { database, coherent, fixture, observe, state, formation } = world;
    const person = await seedPerson(database.db);
    await coherent(person);
    const first = (await state(person)).activeRunId!;
    expect(await runsOf(person)).toHaveLength(1);

    const flight = await holdingRun(person);
    expect(flight.runId).toBe(first);
    const frozenRevision = (await state(person)).desiredRevision;
    await observe(person, await fixture(undefined, topic, [facet]));
    await observe(person, await fixture(undefined, topic, [otherFacet]));
    const during = await state(person);
    expect(during.activeRunId).toBe(first);
    expect(during.desiredRevision).toBe(frozenRevision + 2);
    expect(await runsOf(person)).toHaveLength(1);

    flight.answer({ kind: 'success', text: JSON.stringify(formation(flight.frozen())) });
    await flight.finished;

    // The valid answer was applied although two Scrolls were read while it was in flight.
    expect(flight.run.model.calls).toHaveLength(1);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await runsOf(person)).toContainEqual({ id: first, status: 'accepted', outcome: 'applied' });
    expect(await ledgerOf(person)).toEqual(['completed']);

    // Exactly one successor takes up the later reading, and it waits its interval before it starts.
    const after = await state(person);
    expect(after.activeRunId).toBeDefined();
    expect(after.activeRunId).not.toBe(first);
    expect(await runsOf(person)).toHaveLength(2);
    const settledBy = Date.now();
    const { startAfter } = await wakeOf(person, after.activeRunId!);
    expect(startAfter!.getTime()).toBeGreaterThan(settledBy + 10_000);
    expect(startAfter!.getTime()).toBeLessThan(settledBy + 40_000);
    const paced = await database.db
      .selectFrom('geography.state')
      .select('next_run_not_before')
      .where('universe_id', '=', person.universeId)
      .executeTakeFirstOrThrow();
    expect(paced.next_run_not_before!.getTime()).toBeCloseTo(startAfter!.getTime(), -3);

    // More reading while it waits joins that one run: no new run and no new wake.
    const wakeBefore = (await wakeOf(person, after.activeRunId!)).wakeId;
    await observe(person, await fixture(undefined, topic, [facet]));
    expect((await state(person)).activeRunId).toBe(after.activeRunId);
    expect(await runsOf(person)).toHaveLength(2);
    expect((await wakeOf(person, after.activeRunId!)).wakeId).toBe(wakeBefore);
  });

  it('asks no model and keeps no ledger run when reading leaves nothing for it to decide', async () => {
    const { database, fixture, observe, state, runner, job } = world;
    const person = await seedPerson(database.db);
    await observe(person, await fixture(undefined, topic, [facet]));
    const runId = (await state(person)).activeRunId!;
    const run = runner(person);
    await run.run(await job(person, runId), signal());
    expect(run.model.calls).toHaveLength(0);
    expect(await runsOf(person)).toEqual([{ id: runId, status: 'insufficient', outcome: 'no_changes' }]);
    expect(await ledgerOf(person)).toEqual([]);
    expect((await state(person)).activeRunId).toBeUndefined();
  });

  it('applies what is due when the model adds nothing, as a valid proposal plus the rules', async () => {
    const { database, coherent, state, runner, job } = world;
    const person = await seedPerson(database.db);
    await coherent(person);
    const runId = (await state(person)).activeRunId!;
    const run = runner(person, () => ({
      kind: 'success',
      text: JSON.stringify({ version: 'cartographer-proposal.v1', operations: [] }),
    }));
    await run.run(await job(person, runId), signal());
    expect(run.model.calls).toHaveLength(1);
    expect(await runsOf(person)).toEqual([{ id: runId, status: 'accepted', outcome: 'applied_with_rules' }]);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await ledgerOf(person)).toEqual(['completed']);
  });

  it('accepts and applies a route the model adds to a second planet that is only due', async () => {
    const { database, coherent, fixture, observe, state, runner, job } = world;
    const person = await seedPerson(database.db);
    await coherent(person);
    const first = runner(person);
    await first.run(await job(person, (await state(person)).activeRunId!), signal());
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);

    // Three Tides Scrolls make a second planet of the same system due.
    for (let i = 0; i < 3; i++)
      await observe(
        person,
        await fixture(undefined, 'earth.tides', [i === 1 ? 'earth.tides.alignment' : 'earth.tides.forcing']),
      );
    const runId = (await state(person)).activeRunId!;
    // The model answers with its addition only: a route between the formed planet and the due one.
    const tides = runner(person, (context) => {
      const formed = context.facts.objects.find((place) => place.kind === 'planet')!;
      const due = context.facts.candidates.find((c) => c.kind === 'planet' && c.conceptId === 'earth.tides')!;
      return {
        kind: 'success',
        text: JSON.stringify({
          version: 'cartographer-proposal.v1',
          operations: [
            {
              kind: 'connect_route',
              fromKey: formed.key,
              toKey: due.key,
              supportRefs: context.facts.supports.map((support) => support.ref),
            },
          ],
        }),
      };
    });
    await tides.run(await job(person, runId), signal());

    // Valid on the first answer (no repair), and applied together with the places the rules owed.
    expect(tides.model.calls).toHaveLength(1);
    expect(await runsOf(person)).toContainEqual({ id: runId, status: 'accepted', outcome: 'applied_with_rules' });
    const universe = await world.snapshot(person);
    if (universe.status !== 'ready') throw new Error('CI ready expected');
    expect(universe.page.objects.filter((place) => place.kind === 'planet')).toHaveLength(2);
    expect(universe.page.routes).toHaveLength(1);
    expect(await ledgerOf(person)).toEqual(['completed', 'completed']);
  });

  /** A run claimed by code whose context layout hashed differently, that died after the claim. */
  async function frozenUnderOlderLayout(person: FixturePerson) {
    const { base, state, runner, job } = world;
    const runId = (await state(person)).activeRunId!;
    const { ports } = runner(person);
    const older = makeRunCartographer({
      ...ports,
      // Only the two context hashes differ, as if the model-facing context had another layout.
      hash: (value) =>
        base.hash(
          typeof value === 'object' && value !== null && ('bundleRef' in value || 'factsSha256' in value)
            ? { layout: 'before-due-items', value }
            : value,
        ),
      harness: { ...ports.harness, proposePersonal: () => Promise.reject(new Error('CI crash after claim')) },
    });
    await expect(older(await job(person, runId), signal())).rejects.toThrow('CI crash after claim');
    await world.database.db
      .updateTable('geography.runs')
      .set({ claim_until: sql<Date>`now() - interval '1 minute'` })
      .where('universe_id', '=', person.universeId)
      .where('id', '=', runId)
      .execute();
    return runId;
  }

  it('retires a run frozen under an older context hash and starts a successor, so it does not hold the scope', async () => {
    const { database, coherent, state, runner, job } = world;
    const person = await seedPerson(database.db);
    await coherent(person);
    const runId = await frozenUnderOlderLayout(person);
    expect(await runsOf(person)).toMatchObject([{ id: runId, status: 'prepared' }]);

    const today = runner(person);
    await today.run(await job(person, runId), signal());
    expect(today.model.calls).toHaveLength(0);
    expect(await ledgerOf(person)).toEqual([]);
    const [retired, successor] = await runsOf(person);
    expect(retired).toEqual({ id: runId, status: 'stale', outcome: 'context_changed' });
    expect(successor).toMatchObject({ status: 'queued' });
    expect((await state(person)).activeRunId).toBe(successor!.id);

    // The successor is frozen by today's code and forms the places.
    const next = runner(person);
    await next.run(await job(person, successor!.id), signal());
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
  });

  it('leaves a run frozen under an older context hash alone while accounting shows a live attempt', async () => {
    const { database, coherent, state, runner, job } = world;
    const person = await seedPerson(database.db);
    await coherent(person);
    const runId = await frozenUnderOlderLayout(person);
    const { ports } = runner(person);
    await makeRunCartographer({
      ...ports,
      harness: {
        ...ports.harness,
        readPersonalRunAccounting: async (scope, id, readBinding) => {
          const accounting = await ports.harness.readPersonalRunAccounting(scope, id, readBinding);
          return accounting.kind === 'unavailable'
            ? accounting
            : { kind: 'accounted', disposition: 'unresolved', attempts: [] };
        },
      },
    })(await job(person, runId), signal());
    expect(await runsOf(person)).toMatchObject([{ id: runId, status: 'prepared' }]);
    expect((await state(person)).activeRunId).toBe(runId);
  });

  it('completes the ledger run of a valid answer that concludes nothing needs changing', async () => {
    const { database, fixture, observe, state, runner, job } = world;
    const person = await seedPerson(database.db);
    await observe(person, await fixture(undefined, topic, [facet]));
    const asked = await world.request(person.authority, { commandId: randomUUID() });
    if (asked.kind !== 'accepted') throw new Error('CI request refused');
    const run = runner(person, () => ({
      kind: 'success',
      text: JSON.stringify({ version: 'cartographer-proposal.v1', operations: [] }),
    }));
    await run.run(await job(person, asked.runId), signal());
    expect(run.model.calls).toHaveLength(1);
    expect(await runsOf(person)).toEqual([{ id: asked.runId, status: 'insufficient', outcome: 'no_changes' }]);
    expect(await ledgerOf(person)).toEqual(['completed']);
    expect((await state(person)).activeRunId).toBeUndefined();
  });

  it('voids an answer in flight only when its authority changes, and cancels its ledger run then', async () => {
    const { database, coherent, formation } = world;
    const person = await seedPerson(database.db);
    const assets = await coherent(person);
    const flight = await holdingRun(person);
    await database.db
      .updateTable('content.assets')
      .set({ status: 'withdrawn' })
      .where('id', '=', assets[0]!.assetId)
      .execute();
    flight.answer({ kind: 'success', text: JSON.stringify(formation(flight.frozen())) });
    await flight.finished;
    expect(await runsOf(person)).toEqual([{ id: flight.runId, status: 'stale', outcome: 'source_changed' }]);
    expect(await ledgerOf(person)).toEqual(['cancelled']);
    expect(await placeKinds(person)).toEqual([]);
  });

  it('ends a run that budget refuses with the rules applied and nothing left admitted', async () => {
    const { database, coherent, state, runner, job } = world;
    const exhausted = {
      ...fixtureSettings,
      caps: { ...fixtureSettings.caps, scope: { requestsPerDay: 0, tokensPerDay: 0 } },
    };
    const person = await seedPerson(database.db);
    await coherent(person);
    const runId = (await state(person)).activeRunId!;
    const run = runner(person, undefined, {}, exhausted);
    await run.run(await job(person, runId), signal());
    expect(run.model.calls).toHaveLength(0);
    expect(await runsOf(person)).toEqual([{ id: runId, status: 'accepted', outcome: 'applied_by_rules' }]);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await ledgerOf(person)).toEqual(['completed']);

    // An explicit request with nothing due is refused by the same budget: the run is closed, not admitted.
    const asked = await world.request(person.authority, { commandId: randomUUID() });
    if (asked.kind !== 'accepted') throw new Error('CI request refused');
    const refused = runner(person, undefined, {}, exhausted);
    await refused.run(await job(person, asked.runId), signal());
    expect(await runsOf(person)).toContainEqual({ id: asked.runId, status: 'rejected', outcome: 'budget_exhausted' });
    expect((await ledgerOf(person)).filter((state) => state === 'admitted')).toEqual([]);
    expect((await state(person)).activeRunId).toBeUndefined();
  });
  it('settles by the rules when the ledger run behind it was closed, instead of failing to apply for ever', async () => {
    const { database, coherent, state, runner, job } = world;
    const person = await seedPerson(database.db);
    await coherent(person);
    const runId = (await state(person)).activeRunId!;
    const base = runner(person);
    // The model call admits the ledger run; the idle sweep then closes it before the owner can apply.
    await makeRunCartographer({
      ...base.ports,
      harness: {
        ...base.ports.harness,
        proposePersonal: async (input, abort) => {
          await base.ports.harness.proposePersonal(input, abort);
          await new Promise((resolve) => setTimeout(resolve, 30));
          expect(await reasoningOperatorFor(database.db, silent).closeIdleRuns(0)).toBeGreaterThanOrEqual(1);
          return { kind: 'refused', reason: 'run_closed' };
        },
      },
    })(await job(person, runId), signal());
    expect(await runsOf(person)).toEqual([{ id: runId, status: 'accepted', outcome: 'applied_by_rules' }]);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await ledgerOf(person)).toEqual(['cancelled']);
    expect((await state(person)).activeRunId).toBeUndefined();
  });
});
