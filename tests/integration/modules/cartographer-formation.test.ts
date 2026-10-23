import { sql } from 'kysely';
import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { makeRunCartographer } from '@knowscroll/backend/modules/geography/nest-providers';
import { CONCEPTS } from '@knowscroll/backend/modules/content';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { attemptsOf, signal } from '../support/fixture-model.js';
import { seedPerson, type FixturePerson } from '../support/fixtures.js';
import { geographyWorld, topic, facet, otherFacet, type GeographyWorld } from '../support/geography-world.js';
import {
  answerWith,
  enableProductionScope,
  fixtureClaimSelection,
  fixtureProduction,
  fixtureWriterDraft,
} from '../support/generated-scroll.js';
import { TOPICS } from '../../../packages/backend/src/modules/content/production/topics.js';

/**
 * How reading becomes places: dust, then a system with its star, then a planet with its regions.
 * Sources and model answers are authored CI fixtures; none of this is provider output.
 */
const garbage: FixtureScenario = { kind: 'malformed' };
const providerDown: FixtureScenario = { kind: 'server_error', status: 503 };

function cartographer(world: GeographyWorld) {
  const { database, state, runner, job, snapshot, emerging } = world;
  /** Runs the person's active Cartographer run once, with the given model behaviour. */
  async function cartograph(
    person: FixturePerson,
    script?: Parameters<typeof runner>[1],
    overrides?: Parameters<typeof runner>[2],
  ) {
    const runId = (await state(person)).activeRunId;
    if (!runId) throw new Error('CI expected an active Cartographer run');
    const run = runner(person, script, overrides);
    await run.run(await job(person, runId), signal());
    return { ...run, runId };
  }
  async function placeKinds(person: FixturePerson) {
    const result = await snapshot(person);
    return 'page' in result ? result.page.objects.map((place) => place.kind).sort() : [];
  }
  async function dust(person: FixturePerson) {
    const result = await emerging(person.authority, {});
    if (result.kind !== 'read') throw new Error('CI emerging read refused');
    return result.emerging.dust;
  }
  async function runOf(runId: string) {
    return database.db
      .selectFrom('geography.runs')
      .select(['status', 'outcome'])
      .where('id', '=', runId)
      .executeTakeFirstOrThrow();
  }
  return { cartograph, placeKinds, dust, runOf };
}

describe('Cartographer formation from reading (real PostgreSQL CI fixtures)', () => {
  let world: GeographyWorld, steps: ReturnType<typeof cartographer>;
  beforeAll(async () => {
    world = await geographyWorld('cartographer_formation');
    steps = cartographer(world);
  });
  afterAll(() => world.close());

  it('gathers dust, then a system with its star, then a planet with its regions, however unusable the model answers', async () => {
    const { database, fixture, observe } = world;
    const { cartograph, placeKinds, dust, runOf } = steps;
    const person = await seedPerson(database.db);
    expect(await dust(person)).toEqual([]);

    await observe(person, await fixture(undefined, topic, [facet]));
    const first = await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual([]);
    expect(await dust(person)).toHaveLength(1);
    expect(await runOf(first.runId)).toMatchObject({ status: 'rejected', outcome: 'invalid_output' });

    await observe(person, await fixture(undefined, topic, [otherFacet]));
    const second = await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual(['star', 'system']);
    expect(await dust(person)).toEqual([]);
    expect(await runOf(second.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });

    await observe(person, await fixture(undefined, topic, [facet]));
    const third = await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await runOf(third.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
    const universe = await world.snapshot(person);
    if (universe.status !== 'ready') throw new Error('CI ready expected');
    expect(universe.page.objects.find((place) => place.kind === 'planet')?.label).toBe('Seasons');
  });

  it('forms the Seasons planet from three Scrolls published by the production path', async () => {
    const { database, observe } = world;
    const { cartograph, placeKinds, dust } = steps;
    await enableProductionScope(database.db);
    const scrolls = [];
    for (const key of ['seasons', 'seasons-hemispheres', 'seasons-limits'] as const) {
      const recipe = TOPICS[key];
      const production = fixtureProduction(database.db, (call) =>
        answerWith(call === 1 ? fixtureClaimSelection : fixtureWriterDraft(recipe.interactive)),
      );
      expect(await production.produce(key, false, signal(), false)).toMatchObject({
        outcome: 'published',
        assetId: recipe.assetId,
      });
      const row = await database.db
        .selectFrom('content.asset_revisions')
        .select('reading_facts')
        .where('asset_id', '=', recipe.assetId)
        .where('revision', '=', 1)
        .executeTakeFirstOrThrow();
      const blocks = (row.reading_facts as { blocks: { id: string }[] }).blocks.map((block) => block.id);
      scrolls.push({ assetId: recipe.assetId, revision: 1, blocks });
    }
    const person = await seedPerson(database.db);
    await observe(person, scrolls[0]!);
    await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual([]);
    expect(await dust(person)).toHaveLength(1);
    await observe(person, scrolls[1]!);
    await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual(['star', 'system']);
    await observe(person, scrolls[2]!);
    await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'region', 'star', 'system']);
  });

  it('applies the rules when the provider fails, and settles a run with nothing due so the next encounter starts another', async () => {
    const { database, fixture, observe, state } = world;
    const { cartograph, placeKinds, runOf } = steps;
    const person = await seedPerson(database.db);
    await observe(person, await fixture(undefined, topic, [facet]));
    const nothingDue = await cartograph(person, () => providerDown);
    expect(await runOf(nothingDue.runId)).toMatchObject({ status: 'rejected', outcome: 'failed' });
    expect((await state(person)).activeRunId).toBeUndefined();

    await observe(person, await fixture(undefined, topic, [otherFacet]));
    const due = await cartograph(person, () => providerDown);
    expect(await placeKinds(person)).toEqual(['star', 'system']);
    expect(await runOf(due.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
  });

  it('completes a valid but partial model proposal with the planet the rules require', async () => {
    const { database, coherent, formation } = world;
    const { cartograph, placeKinds, runOf } = steps;
    const person = await seedPerson(database.db);
    await coherent(person);
    const partial = await cartograph(person, (context) => ({
      kind: 'success',
      text: JSON.stringify({
        ...formation(context),
        operations: formation(context).operations.filter((operation) =>
          ['create_system', 'establish_star'].includes(operation.kind),
        ),
      }),
    }));
    expect(partial.model.calls).toHaveLength(1);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await runOf(partial.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_with_rules' });
  });

  it('keeps one stable, person-specific cue per gathering system until the system is established', async () => {
    const { database, fixture, observe } = world;
    const { cartograph, dust } = steps;
    const person = await seedPerson(database.db);
    await observe(person, await fixture(undefined, topic, [facet]));
    const before = await dust(person);
    expect(before).toHaveLength(1);
    expect(await dust(person)).toEqual(before);
    const other = await seedPerson(database.db);
    await observe(other, await fixture(undefined, topic, [facet]));
    expect(await dust(other)).not.toEqual(before);
    await observe(person, await fixture(undefined, topic, [otherFacet]));
    await cartograph(person, () => garbage);
    expect(await dust(person)).toEqual([]);
  });

  it('forms only dust from three units in three different systems', async () => {
    const { database, fixture, observe } = world;
    const { cartograph, placeKinds, dust } = steps;
    const person = await seedPerson(database.db);
    const onePlanetPerSystem = [
      ...new Map(CONCEPTS.filter((t) => t.parent !== null).map((t) => [t.parent, t])).values(),
    ];
    for (const planet of onePlanetPerSystem.slice(0, 3))
      await observe(person, await fixture(undefined, planet.id, [planet.facets[0]!.id]));
    await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual([]);
    expect(await dust(person)).toHaveLength(3);
  });

  it('forms a system but no planet from three units spread over three planets of one system', async () => {
    const { database, fixture, observe } = world;
    const { cartograph, placeKinds } = steps;
    const person = await seedPerson(database.db);
    for (const planet of CONCEPTS.filter((t) => t.parent === 'earth').slice(0, 3))
      await observe(person, await fixture(undefined, planet.id, [planet.facets[0]!.id]));
    await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual(['star', 'system']);
  });

  it('only makes places quiet after long inactivity, keeping every id, label and origin', async () => {
    const { database, coherent, fixture, observe, snapshot } = world;
    const { cartograph } = steps;
    const person = await seedPerson(database.db);
    const recent = await coherent(person);
    await cartograph(person);
    const formed = await snapshot(person);
    if (formed.status !== 'ready') throw new Error('CI ready expected');
    for (const old of recent) {
      const aged = await fixture(
        old.unit,
        topic,
        old.map.bindings.map((binding) => binding.facetId),
      );
      await observe(person, aged, [], 40 * 24 * 60);
      await database.db
        .updateTable('content.assets')
        .set({ status: 'withdrawn' })
        .where('id', '=', old.assetId)
        .execute();
    }
    await cartograph(person, () => garbage);
    const quiet = await snapshot(person);
    if (quiet.status !== 'ready') throw new Error('CI ready expected');
    const sorted = (places: typeof quiet.page.objects) => [...places].sort((a, b) => a.id.localeCompare(b.id));
    expect(
      sorted(quiet.page.objects).map(({ id, label, originTransitionId }) => ({ id, label, originTransitionId })),
    ).toEqual(
      sorted(formed.page.objects).map(({ id, label, originTransitionId }) => ({ id, label, originTransitionId })),
    );
    expect(
      quiet.page.objects.every(
        (place) => place.activity.availability === 'available' && place.activity.state === 'quiet',
      ),
    ).toBe(true);
  });

  it('removes the places, the support behind them and the dust when the person clears everything', async () => {
    const { database, fixture, observe, read, scope } = world;
    const { cartograph, placeKinds, dust } = steps;
    const person = await seedPerson(database.db);
    await observe(person, await fixture(undefined, topic, [facet]));
    expect(await dust(person)).toHaveLength(1);
    await observe(person, await fixture(undefined, topic, [otherFacet]));
    await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual(['star', 'system']);
    const stores = [
      'personal_context.topics',
      'personal_context.coverage_contributions',
      'personal_context.coverage_references',
      'personal_context.coverage_supports',
      'personal_context.recording_coverage_contributions',
      'personal_context.recording_coverage_references',
      'geography.state',
      'geography.runs',
      'geography.objects',
      'geography.deltas',
    ] as const;
    const rowsOf = async () =>
      Object.fromEntries(
        await Promise.all(
          stores.map(
            async (store) =>
              [
                store,
                (
                  await sql<{
                    n: number;
                  }>`select count(*)::int as n from ${sql.table(store)} where universe_id = ${person.universeId}::uuid`.execute(
                    database.db,
                  )
                ).rows[0]!.n,
              ] as const,
          ),
        ),
      ) as Record<(typeof stores)[number], number>;
    // The test can only fail if there is something to erase.
    const before = await rowsOf();
    expect(before['personal_context.topics']).toBeGreaterThan(0);
    expect(
      before['personal_context.coverage_references'] + before['personal_context.recording_coverage_references'],
    ).toBeGreaterThan(0);
    for (const store of ['geography.state', 'geography.runs', 'geography.objects', 'geography.deltas'] as const)
      expect(before[store]).toBeGreaterThan(0);

    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    const fresh = { ...person.authority, privacyEpoch: 2 };
    await scope()(fresh, (sc) => eraseUniverse(sc, personalStores));
    expect(await rowsOf()).toEqual(Object.fromEntries(stores.map((store) => [store, 0])));
    expect(await world.emerging(person.authority, {})).toEqual({ kind: 'refused', reason: 'scope_refused' });
    expect(await world.emerging(fresh, {})).toMatchObject({
      kind: 'read',
      emerging: { dust: [], geography: { revision: 0 } },
    });
    expect(await read(fresh, { selection: { kind: 'universe' }, limit: 100 })).toMatchObject({
      kind: 'read',
      snapshot: { status: 'empty' },
    });
  });

  it('strands nobody while the role is switched off: reading after it is switched on forms the places', async () => {
    const { database, fixture, observe, state } = world;
    const { cartograph, placeKinds, runOf } = steps;
    const person = await seedPerson(database.db);
    const off = { enabled: () => false };
    await observe(person, await fixture(undefined, topic, [facet]));
    const first = await cartograph(person, undefined, off);
    expect(await runOf(first.runId)).toMatchObject({ status: 'insufficient', outcome: 'disabled' });
    expect((await state(person)).activeRunId).toBeUndefined();
    await observe(person, await fixture(undefined, topic, [otherFacet]));
    await cartograph(person, undefined, off);
    expect(await placeKinds(person)).toEqual([]);
    // The role is switched on. The next reading starts a run that forms what all three Scrolls earned.
    await observe(person, await fixture(undefined, topic, [facet]));
    const on = await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await runOf(on.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
  });

  it.each(['disabled', 'provider_unavailable'] as const)(
    'restarts a run that earlier code parked as blocked/%s on the next reading',
    async (parkedOutcome) => {
      const { database, fixture, observe, state } = world;
      const { cartograph, placeKinds, runOf } = steps;
      const person = await seedPerson(database.db);
      await observe(person, await fixture(undefined, topic, [facet]));
      const parked = (await state(person)).activeRunId!;
      await sql`update geography.runs set status='blocked', outcome=${parkedOutcome}, normal_wake_id=null
        where universe_id = ${person.universeId}::uuid and id = ${parked}::uuid`.execute(database.db);
      expect(await runOf(parked)).toMatchObject({ status: 'blocked', outcome: parkedOutcome });
      await observe(person, await fixture(undefined, topic, [otherFacet]));
      expect((await state(person)).activeRunId).toBe(parked);
      const woken = await cartograph(person, () => garbage);
      expect(woken.runId).toBe(parked);
      expect(await placeKinds(person)).toEqual(['star', 'system']);
      expect(await runOf(parked)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
    },
  );

  it('forms places by the rules when the harness refuses before admitting a run, and releases the run when nothing is due', async () => {
    const { database, coherent, fixture, observe } = world;
    const { placeKinds, runOf } = steps;
    const noLedgerRun = () => {
      throw new Error('CI a refusal before admission has no ledger run to apply under or close');
    };
    async function refused(person: FixturePerson) {
      const base = world.runner(person);
      const runId = (await world.state(person)).activeRunId!;
      await makeRunCartographer({
        ...base.ports,
        harness: {
          ...base.ports.harness,
          proposePersonal: () => Promise.resolve({ kind: 'refused', reason: 'request_too_large' }),
          withPersonalApply: noLedgerRun,
          closePersonalRun: noLedgerRun,
        },
      })(await world.job(person, runId), signal());
      return runId;
    }
    const heavy = await seedPerson(database.db);
    await coherent(heavy);
    const formed = await refused(heavy);
    expect(await placeKinds(heavy)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await runOf(formed)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
    expect(await attemptsOf(database.db, heavy.universeId)).toEqual([]);
    expect((await world.state(heavy)).activeRunId).toBeUndefined();

    const light = await seedPerson(database.db);
    await observe(light, await fixture(undefined, topic, [facet]));
    const released = await refused(light);
    expect(await runOf(released)).toMatchObject({ status: 'insufficient', outcome: 'request_too_large' });
    expect((await world.state(light)).activeRunId).toBeUndefined();
  });

  it('applies the rules when a refusal comes from a ledger run that is already closed', async () => {
    const { database, coherent } = world;
    const { placeKinds, runOf } = steps;
    const person = await seedPerson(database.db);
    await coherent(person);
    const runId = (await world.state(person)).activeRunId!;
    const base = world.runner(person);
    await makeRunCartographer({
      ...base.ports,
      harness: {
        ...base.ports.harness,
        // The real attempt admits the ledger run; the answer then reports it closed.
        proposePersonal: async (input, abort) => {
          await base.ports.harness.proposePersonal(input, abort);
          return { kind: 'refused', reason: 'run_closed' };
        },
        closePersonalRun: () => Promise.resolve('not_open'),
      },
    })(await world.job(person, runId), signal());
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
    expect(await runOf(runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
  });

  it('lets the rules win when the model relabels a place that the rules also put to sleep', async () => {
    const { database, coherent, fixture, observe, snapshot } = world;
    const { cartograph, runOf } = steps;
    const person = await seedPerson(database.db);
    const recent = await coherent(person);
    await cartograph(person);
    const formed = await snapshot(person);
    if (formed.status !== 'ready') throw new Error('CI ready expected');
    const planet = formed.page.objects.find((place) => place.kind === 'planet')!;
    for (const old of recent) {
      const aged = await fixture(
        old.unit,
        topic,
        old.map.bindings.map((binding) => binding.facetId),
      );
      await observe(person, aged, [], 40 * 24 * 60);
      await database.db
        .updateTable('content.assets')
        .set({ status: 'withdrawn' })
        .where('id', '=', old.assetId)
        .execute();
    }
    const relabel = await cartograph(person, (context) => ({
      kind: 'success',
      text: JSON.stringify({
        version: 'cartographer-proposal.v1',
        operations: [
          {
            kind: 'revise_label',
            objectId: planet.id,
            label: context.facts.objects.find((place) => place.id === planet.id)!.labels[1],
            supportRefs: context.facts.supports.map((support) => support.ref),
          },
        ],
      }),
    }));
    expect(await runOf(relabel.runId)).toMatchObject({ status: 'accepted', outcome: 'applied_by_rules' });
    const after = await snapshot(person);
    if (after.status !== 'ready') throw new Error('CI ready expected');
    expect(after.page.objects.find((place) => place.id === planet.id)).toMatchObject({
      label: planet.label,
      activity: { availability: 'available', state: 'quiet' },
    });
  });

  it('keeps forming places for a reader with more than 100 covered facet and unit pairs', async () => {
    const { database, base, fixture, observe, scope, snapshot } = world;
    const { cartograph } = steps;
    const planets = CONCEPTS.filter((concept) => concept.parent !== null);
    // The last planet in key order is the one a plain first-100 cut would drop.
    const target = [...planets].sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
    const person = await seedPerson(database.db);
    let pairs = 0;
    for (const planet of planets) {
      const facets = planet.facets.map((entry) => entry.id);
      for (let unit = 0; unit < (planet === target ? 3 : 2); unit++) {
        await observe(person, await fixture(undefined, planet.id, facets));
        pairs += facets.length;
      }
    }
    expect(pairs).toBeGreaterThan(100);
    const discovered = await scope()(person.authority, (sc) => base.readInputs(sc));
    expect(discovered).toMatchObject({ kind: 'entered', value: { availability: 'available' } });
    if (discovered.kind !== 'entered') throw new Error('CI scope refused');
    expect(discovered.value.probes.length).toBe(pairs);

    let frozen: Parameters<NonNullable<Parameters<typeof cartograph>[1]>>[0] | undefined;
    await cartograph(person, (frozenContext) => {
      frozen = frozenContext;
      return garbage;
    });
    if (!frozen) throw new Error('CI the model never saw a context');
    expect(frozen.facts.supports.length).toBeLessThanOrEqual(100);
    expect(frozen.facts.supports.some((entry) => entry.topicId === target.id)).toBe(true);
    const universe = await snapshot(person);
    if (universe.status !== 'ready') throw new Error('CI ready expected');
    const count = (kind: string) => universe.page.objects.filter((place) => place.kind === kind).length;
    const systems = CONCEPTS.filter((concept) => concept.parent === null).length;
    expect({ system: count('system'), star: count('star'), planet: count('planet'), region: count('region') }).toEqual({
      system: systems,
      star: systems,
      planet: 1,
      region: target.facets.length,
    });
    const planet = universe.page.objects.find((place) => place.kind === 'planet')!;
    expect(universe.page.objects.some((place) => place.kind === 'system' && place.id === planet.parent.id)).toBe(true);
  }, 180_000);
});

describe('Cartographer failure brake (real PostgreSQL CI fixtures)', () => {
  let world: GeographyWorld;
  beforeAll(async () => {
    world = await geographyWorld('cartographer_brake');
  });
  afterAll(() => world.close());

  it('still forms places by the rules once five failed runs have stopped the role for the day', async () => {
    const { database, fixture, observe, coherent } = world;
    const { cartograph, placeKinds } = cartographer(world);
    for (let failed = 0; failed < 5; failed++) {
      const person = await seedPerson(database.db);
      await observe(person, await fixture(undefined, topic, [facet]));
      await cartograph(person, () => providerDown);
    }
    const person = await seedPerson(database.db);
    await coherent(person);
    const stopped = await cartograph(person);
    expect(stopped.model.calls).toHaveLength(0);
    expect(await placeKinds(person)).toEqual(['planet', 'region', 'region', 'star', 'system']);
  });
});
