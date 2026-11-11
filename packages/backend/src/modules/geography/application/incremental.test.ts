import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { dueCreations, requiredChanges } from '../domain/formation.js';
import { EVALUATION } from '../domain/evaluation.js';
import { QUIET_SWEEP } from '../domain/quiet.js';
import {
  MAX_PROPOSAL_OPERATIONS,
  activityFor,
  semanticKey,
  type Candidate,
  type FormationFacts,
  type Place,
  type Support,
} from '../domain/policy.js';
import { applyProposal, commitEvaluation } from './apply.js';
import { evaluationOf, prepareGeography } from './context.js';
import { makeSettleQuiet } from './quiet.js';
import { World, planetReadings, uuid, type Reading } from '../adapters/world.fixture.js';

/**
 * The differential test of incremental formation (#674, D-416): on random histories of reading, running the real prepare and
 * apply over the dirty set, a batch at a time, forms exactly the places that evaluating the whole catalogue forms, with the
 * same activity. Readings, topics and times are authored fixtures over the real concept catalogue.
 */
const DAY = 86_400_000;
const systems = [...new Set(CONCEPTS.filter((topic) => topic.parent !== null).map((topic) => topic.parent!))].slice(
  0,
  3,
);
const topics = systems.flatMap((system) =>
  CONCEPTS.filter((topic) => topic.parent === system)
    .slice(0, 3)
    .map((topic) => topic),
);

/** Runs Cartographer runs, rules only, until nothing is dirty: each takes the topics it takes and applies what is due. */
async function runRules(world: World): Promise<number> {
  const ports = world.ports();
  let runs = 0;
  for (; runs < 60 && world.dirty.size > 0; runs++) {
    const prepared = await prepareGeography(ports, world.cap(), { kind: 'dirty' });
    if (prepared.kind === 'unavailable') throw new Error(`CI refusal ${prepared.reason}`);
    const { context } = prepared;
    const rules = requiredChanges(context.facts);
    if (rules.operations.length) {
      const applied = await applyProposal(ports, world.cap(), undefined, context, rules, () => Promise.resolve());
      if (applied.kind === 'refused') throw new Error(`CI apply refused ${applied.reason}`);
    } else
      await commitEvaluation(ports, world.cap().personal, context.facts, evaluationOf(context), { clearDirty: true });
  }
  return runs;
}

/** The quiet sweep and settle over the world, as the worker runs them: due places in chunks of one settle. */
async function settleQuiet(world: World): Promise<void> {
  const base = world.ports();
  const settle = makeSettleQuiet({
    ...base,
    withScope: (_authority: unknown, work: (scope: unknown) => Promise<unknown>) =>
      work(world.cap().personal).then((value) => ({ kind: 'entered', value })),
    fenceOwn: () => Promise.resolve({ kind: 'active' }),
    fenceRecording: () => Promise.resolve({ kind: 'recording', scope: world.cap() }),
    enabled: () => true,
  } as unknown as Parameters<typeof makeSettleQuiet>[0]);
  for (let pass = 0; pass < 30; pass++) {
    const due = await base.store.duePlaces(world.cap().personal, new Date(world.now), 100);
    if (!due.length) return;
    for (let start = 0; start < due.length; start += QUIET_SWEEP.placesPerSettle) {
      await settle({
        v: 2,
        universeId: uuid(7),
        privacyEpoch: 1,
        recordingGeneration: 1,
        objectIds: due.slice(start, start + QUIET_SWEEP.placesPerSettle).map((place) => place.id),
      });
    }
  }
}

/** What the rules form from every reading, evaluating the whole catalogue at once: the reference. */
function wholeCatalogue(readings: readonly Reading[], now: string, untrusted: ReadonlySet<string> = new Set()) {
  const newest = new Map<string, Reading>();
  for (const reading of readings) {
    const key = `${reading.topicId}|${reading.facetId}|${reading.unit}`;
    if (untrusted.has(key)) continue;
    const best = newest.get(key);
    if (!best || Date.parse(reading.at) > Date.parse(best.at)) newest.set(key, reading);
  }
  const supports: Support[] = [...newest.values()].map((reading) => ({
    ref: `ref:${reading.topicId}|${reading.facetId}|${reading.unit}`,
    topicId: reading.topicId,
    facetId: reading.facetId,
    explanationUnitId: reading.unit,
    truthStatus: 'factual',
    activatedAt: reading.at,
  }));
  const slot = (kind: Candidate['kind'], conceptId: string, parentKey: string, n: number): Candidate => ({
    key: semanticKey(kind, conceptId),
    id: uuid(3000 + n),
    kind,
    conceptId,
    parentKey,
    truthStatus: 'factual',
    labels: [conceptId],
  });
  const candidates = CONCEPTS.flatMap((topic, index): Candidate[] =>
    topic.parent === null
      ? [
          slot('system', topic.id, 'universe', index * 100),
          slot('star', topic.id, semanticKey('system', topic.id), index * 100 + 1),
        ]
      : [
          slot('planet', topic.id, semanticKey('system', topic.parent), index * 100),
          ...topic.facets.map((facet, n) =>
            slot('region', facet.id, semanticKey('planet', topic.id), index * 100 + n + 1),
          ),
        ],
  );
  const factsOf = (objects: Place[]): FormationFacts => ({
    catalogue: CONCEPTS.map((topic) => ({ id: topic.id, parent: topic.parent, facets: topic.facets.map((f) => f.id) })),
    supports,
    candidates,
    objects,
    routes: [],
    evaluatedAt: now,
    completeness: 'not_asserted',
  });
  const objects: Place[] = [];
  for (let due = dueCreations(factsOf(objects)); due.length; due = dueCreations(factsOf(objects)))
    for (const operation of due) {
      const candidate = candidates.find((entry) => entry.key === operation.key)!;
      objects.push({
        ...candidate,
        label: operation.label,
        objectRevision: 1,
        originTransitionId: uuid(1),
        activity: { availability: 'unavailable' },
      });
    }
  const facts = factsOf(objects);
  return {
    keys: objects.map((object) => object.key).sort(),
    activity: new Map(objects.map((o) => [o.key, activityFor(facts, o)])),
  };
}

describe('incremental formation forms what the whole catalogue forms (#674, D-416)', () => {
  const history = fc.array(
    fc.array(
      fc.record({
        topic: fc.constantFrom(...topics),
        facet: fc.nat(3),
        unit: fc.nat(5),
        ageDays: fc.nat(90),
      }),
      { minLength: 1, maxLength: 4 },
    ),
    { minLength: 1, maxLength: 14 },
  );

  test.prop([history, fc.array(fc.nat(60), { maxLength: 4 }), fc.nat(100)], { numRuns: 100 })(
    'the same places, and the same activity once support has been withdrawn and time has passed',
    async (batches, withdrawals, silentDays) => {
      const world = new World();
      for (const batch of batches) {
        world.read(
          ...batch.map(({ topic, facet, unit, ageDays }) => ({
            topicId: topic.id,
            facetId: topic.facets[facet % topic.facets.length]!.id,
            unit: `unit-${topic.id}-${String(unit)}`,
            at: new Date(Date.parse(world.now) - ageDays * DAY).toISOString(),
          })),
        );
        await runRules(world);
        // After each batch the places formed so far are exactly those the whole catalogue forms from the reading so far.
        expect(world.keysOfPlaces()).toEqual(wholeCatalogue(world.readings, world.now).keys);
      }
      expect(world.dirty.size).toBe(0);
      // Content is withdrawn under some readings, and the topics that held them are read again (a re-read marks them dirty).
      for (const pick of withdrawals) {
        const reading = world.readings[pick % world.readings.length]!;
        world.untrusted.add(`${reading.topicId}|${reading.facetId}|${reading.unit}`);
        world.dirty.set(reading.topicId, world.revision + 1);
      }
      await runRules(world);
      world.now = new Date(Date.parse(world.now) + silentDays * DAY).toISOString();
      await settleQuiet(world);
      await runRules(world);
      const whole = wholeCatalogue(world.readings, world.now, world.untrusted);
      // A place is never removed, so what was formed stays formed even when its support is withdrawn.
      expect(world.keysOfPlaces()).toEqual(expect.arrayContaining(whole.keys));
      if (!withdrawals.length) expect(world.keysOfPlaces()).toEqual(whole.keys);
      for (const [key, implied] of whole.activity) {
        const stored = world.objects.get(key)!;
        if (implied !== undefined)
          expect([key, stored.activity]).toEqual([key, { availability: 'available', state: implied }]);
      }
    },
  );

  it('forms a system only from the units of several topics, though each run reads only the topic that changed', async () => {
    const world = new World();
    const [first, second] = topics.filter((topic) => topic.parent === systems[0]);
    world.read({ topicId: first!.id, facetId: first!.facets[0]!.id, unit: 'one' });
    await runRules(world);
    expect(world.keysOfPlaces()).toEqual([]);
    world.read({ topicId: second!.id, facetId: second!.facets[0]!.id, unit: 'two' });
    await runRules(world);
    expect(world.keysOfPlaces()).toEqual([semanticKey('star', systems[0]!), semanticKey('system', systems[0]!)].sort());
  });

  it('takes a heavy reader a run at a time: every topic is read once, newest first, and nothing is read twice', async () => {
    const world = new World();
    const planets = CONCEPTS.filter((topic) => topic.parent !== null);
    for (const topic of planets) world.read(...planetReadings(world.catalogue, topic.id));
    const runs = await runRules(world);
    // More topics were dirty than one run takes, so they took several runs; each run read at most one run's topics.
    expect(runs).toBeGreaterThanOrEqual(Math.ceil(planets.length / EVALUATION.topicsPerRun));
    expect(world.dirty.size).toBe(0);
    expect(world.keysOfPlaces()).toEqual(wholeCatalogue(world.readings, world.now).keys);
    const named = world.counters.inputReads.flatMap((read) => read.topicIds);
    expect(new Set(named).size).toBe(planets.length);
  });

  it('applies at most one delta of operations at a time and keeps the rest dirty until it is all formed', async () => {
    const world = new World();
    const planets = CONCEPTS.filter((topic) => topic.parent !== null).slice(0, 12);
    for (const topic of planets) world.read(...planetReadings(world.catalogue, topic.id));
    const ports = world.ports();
    const prepared = await prepareGeography(ports, world.cap(), { kind: 'dirty' });
    if (prepared.kind !== 'prepared') throw new Error('CI expected a context');
    expect(requiredChanges(prepared.context.facts).operations).toHaveLength(MAX_PROPOSAL_OPERATIONS);
    expect(dueCreations(prepared.context.facts).length).toBeGreaterThan(MAX_PROPOSAL_OPERATIONS);
    const applied = await applyProposal(
      ports,
      world.cap(),
      undefined,
      prepared.context,
      requiredChanges(prepared.context.facts),
      () => Promise.resolve(),
    );
    expect(applied).toMatchObject({ kind: 'applied', more: true });
    // More is due than one delta holds, so none of what was evaluated is cleared.
    expect(world.dirty.size).toBe(12);
    await runRules(world);
    expect(world.dirty.size).toBe(0);
    expect(world.keysOfPlaces()).toEqual(wholeCatalogue(world.readings, world.now).keys);
  });

  it('keeps evidence that arrives during a run dirty, and gives it its own run', async () => {
    const world = new World();
    const [topic] = topics;
    world.read(...planetReadings(world.catalogue, topic!.id));
    const ports = world.ports();
    const prepared = await prepareGeography(ports, world.cap(), { kind: 'dirty' });
    if (prepared.kind !== 'prepared') throw new Error('CI expected a context');
    // Reading arrives while the run waits (a model call): it commits at a later revision.
    world.read({ topicId: topic!.id, facetId: topic!.facets[0]!.id, unit: 'arrived-later' });
    const applied = await applyProposal(
      ports,
      world.cap(),
      undefined,
      prepared.context,
      requiredChanges(prepared.context.facts),
      () => Promise.resolve(),
    );
    expect(applied.kind).toBe('applied');
    // Its own run takes it: the topic is still dirty.
    expect([...world.dirty.keys()]).toEqual([topic!.id]);
    expect(await runRules(world)).toBe(1);
    expect(world.dirty.size).toBe(0);
  });

  it('records when each place was last supported and when it next needs a look, as the delta commits', async () => {
    const world = new World();
    const [topic] = topics;
    world.read(
      ...planetReadings(world.catalogue, topic!.id).map((reading) => ({
        ...reading,
        at: new Date(Date.parse(world.now) - 10 * DAY).toISOString(),
      })),
    );
    await runRules(world);
    const planet = world.objects.get(semanticKey('planet', topic!.id))!;
    expect(planet.lastSupportAt).toBe(new Date(Date.parse(world.now) - 10 * DAY).toISOString());
    expect(planet.quietCheckAt).toBe(new Date(Date.parse(world.now) - 10 * DAY + 30 * DAY + 1).toISOString());
    // The system and star take the newest over what was read under them.
    expect(world.objects.get(semanticKey('system', topic!.parent!))!.lastSupportAt).toBe(planet.lastSupportAt);
  });

  it('leaves a place that has lost all its support as it is: never quiet, never removed', async () => {
    const world = new World();
    const [topic] = topics;
    world.read(...planetReadings(world.catalogue, topic!.id));
    await runRules(world);
    for (const reading of world.readings) world.untrusted.add(`${reading.topicId}|${reading.facetId}|${reading.unit}`);
    world.dirty.set(topic!.id, world.revision + 1);
    await runRules(world);
    world.now = new Date(Date.parse(world.now) + 90 * DAY).toISOString();
    await settleQuiet(world);
    for (const stored of world.objects.values()) expect(stored.activity).toMatchObject({ state: 'active' });
    expect(world.objects.size).toBe(5);
  });
});
