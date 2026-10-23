import { eraseUniverse } from '@knowscroll/backend/infrastructure/erasure';
import { CONCEPTS } from '@knowscroll/backend/modules/content';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { personalStores } from '@knowscroll/backend/erasure-registry';
import type { FixtureScenario } from '../support/fixture-model-port.js';
import { signal } from '../support/fixture-model.js';
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
  async function cartograph(person: FixturePerson, script?: Parameters<typeof runner>[1]) {
    const runId = (await state(person)).activeRunId;
    if (!runId) throw new Error('CI expected an active Cartographer run');
    const run = runner(person, script);
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
    expect(await runOf(partial.runId)).toMatchObject({ status: 'accepted', outcome: 'applied' });
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

  it('removes the places and the dust when the person clears everything', async () => {
    const { database, fixture, observe, read, scope } = world;
    const { cartograph, placeKinds, dust } = steps;
    const person = await seedPerson(database.db);
    await observe(person, await fixture(undefined, topic, [facet]));
    expect(await dust(person)).toHaveLength(1);
    await observe(person, await fixture(undefined, topic, [otherFacet]));
    await cartograph(person, () => garbage);
    expect(await placeKinds(person)).toEqual(['star', 'system']);
    await database.db
      .updateTable('identity.universes')
      .set({ privacy_epoch: 2 })
      .where('id', '=', person.universeId)
      .execute();
    const fresh = { ...person.authority, privacyEpoch: 2 };
    await scope()(fresh, (sc) => eraseUniverse(sc, personalStores));
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
