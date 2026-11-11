import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { dueCreations, requiredChanges } from '../domain/formation.js';
import { EVALUATION } from '../domain/evaluation.js';
import { derivedRouteId } from '../domain/ids.js';
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
import { makeSettleQuiet, makeSweepQuiet } from './quiet.js';
import { continueCartography } from './request.js';
import { NOW, World, planetReadings, uuid, type Reading } from '../adapters/world.fixture.js';

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
  for (; runs < 60 && world.eligibleDirty().length > 0; runs++) {
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
  if (world.eligibleDirty().length) throw new Error('CI runs did not settle the dirty topics');
  return runs;
}

/** The quiet settle over the world, as the worker runs it, with the scope and the gates it needs answered by the world. */
function settleOf(world: World) {
  const base = world.ports();
  return makeSettleQuiet({
    ...base,
    withScope: (_authority: unknown, work: (scope: unknown) => Promise<unknown>) =>
      work(world.cap().personal).then((value) => ({ kind: 'entered', value })),
    fenceOwn: () => Promise.resolve({ kind: 'active' }),
    fenceRecording: () => Promise.resolve({ kind: 'recording', scope: world.cap() }),
    enabled: () => true,
  } as unknown as Parameters<typeof makeSettleQuiet>[0]);
}
const settleJob = (ids: readonly string[]) => ({
  v: 2 as const,
  universeId: uuid(7),
  privacyEpoch: 1,
  recordingGeneration: 1,
  objectIds: [...ids],
});

/** The quiet sweep and settle over the world, as the worker runs them: due places in chunks of one settle. Returns the outcomes. */
async function settleQuiet(world: World): Promise<string[]> {
  const base = world.ports();
  const settle = settleOf(world);
  const outcomes: string[] = [];
  for (let pass = 0; pass < 30; pass++) {
    const due = await base.store.duePlaces(world.cap().personal, new Date(world.now), 100);
    if (!due.length) return outcomes;
    for (let start = 0; start < due.length; start += QUIET_SWEEP.placesPerSettle)
      outcomes.push(
        (await settle(settleJob(due.slice(start, start + QUIET_SWEEP.placesPerSettle).map((place) => place.id))))
          .outcome,
      );
  }
  return outcomes;
}

/** What the rules form from every reading, evaluating the whole catalogue at once: the reference. */
function wholeCatalogue(
  readings: readonly Reading[],
  now: string,
  untrusted: ReadonlySet<string> = new Set(),
  formed: readonly string[] = [],
) {
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
  // A place is never removed, so the reference starts from the places formed so far and adds what the rules entitle now.
  const objects: Place[] = formed.map((key) => {
    const candidate = candidates.find((entry) => entry.key === key)!;
    return {
      ...candidate,
      label: candidate.labels[0]!,
      objectRevision: 1,
      originTransitionId: uuid(1),
      activity: { availability: 'unavailable' },
    };
  });
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
  /**
   * Steps in any order: reading, content withdrawn (the topic is read again), content restored (a coverage readmission marks
   * its topics dirty), and time passing. After every step the places and the activity are exactly what the whole catalogue
   * gives, from the places formed so far: nothing more, nothing less, whatever the order.
   */
  const step = fc.oneof(
    fc.record({
      kind: fc.constant('read' as const),
      readings: fc.array(
        fc.record({ topic: fc.constantFrom(...topics), facet: fc.nat(3), unit: fc.nat(5), ageDays: fc.nat(90) }),
        { minLength: 1, maxLength: 4 },
      ),
    }),
    fc.record({ kind: fc.constant('withdraw' as const), pick: fc.nat(1000) }),
    fc.record({ kind: fc.constant('restore' as const), pick: fc.nat(1000) }),
    fc.record({ kind: fc.constant('wait' as const), days: fc.nat(70) }),
  );

  test.prop([fc.array(step, { minLength: 2, maxLength: 24 })], { numRuns: 100 })(
    'the same places and the same activity as the whole catalogue, with withdrawals and restorations in any order',
    async (steps) => {
      const world = new World();
      for (const move of steps) {
        if (move.kind === 'read')
          world.read(
            ...move.readings.map(({ topic, facet, unit, ageDays }) => ({
              topicId: topic.id,
              facetId: topic.facets[facet % topic.facets.length]!.id,
              unit: `unit-${topic.id}-${String(unit)}`,
              at: new Date(Date.parse(world.now) - ageDays * DAY).toISOString(),
            })),
          );
        else if (move.kind === 'withdraw' && world.readings.length) {
          const reading = world.readings[move.pick % world.readings.length]!;
          world.untrusted.add(`${reading.topicId}|${reading.facetId}|${reading.unit}`);
          world.touch(reading.topicId);
        } else if (move.kind === 'restore' && world.untrusted.size) {
          const key = [...world.untrusted][move.pick % world.untrusted.size]!;
          world.untrusted.delete(key);
          // What the operator's readmission does: the topics holding the key are judged again, out of any backoff.
          world.touch(key.split('|')[0]!);
        } else if (move.kind === 'wait') world.now = new Date(Date.parse(world.now) + move.days * DAY).toISOString();
        await runRules(world);
        await settleQuiet(world);
        await runRules(world);
        const whole = wholeCatalogue(world.readings, world.now, world.untrusted, world.keysOfPlaces());
        expect(world.keysOfPlaces()).toEqual(whole.keys);
        for (const [key, implied] of whole.activity) {
          const stored = world.objects.get(key)!;
          if (implied !== undefined)
            expect([key, stored.activity]).toEqual([key, { availability: 'available', state: implied }]);
        }
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
    world.touch(topic!.id);
    await runRules(world);
    world.now = new Date(Date.parse(world.now) + 90 * DAY).toISOString();
    await settleQuiet(world);
    for (const stored of world.objects.values()) expect(stored.activity).toMatchObject({ state: 'active' });
    expect(world.objects.size).toBe(5);
  });
});

describe('the review of PR #723 (D-416)', () => {
  const key = (reading: Reading) => `${reading.topicId}|${reading.facetId}|${reading.unit}`;
  const [firstSystem, secondSystem] = systems;
  const firstTopic = topics.find((topic) => topic.parent === firstSystem)!;
  const secondTopic = topics.find((topic) => topic.parent === secondSystem)!;
  const settledOps = (world: World) => [...world.deltas.values()].flatMap((entry) => entry.delta.operations);
  const later = (world: World, ms: number) => {
    world.now = new Date(Date.parse(world.now) + ms).toISOString();
  };

  it('settles the places that can be settled when another place has lost all its support (1)', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, firstTopic.id), ...planetReadings(world.catalogue, secondTopic.id));
    await runRules(world);
    // The content under the first system is withdrawn without any reading (nothing marks it dirty); then 40 days pass.
    for (const reading of world.readings.filter((entry) => entry.topicId === firstTopic.id))
      world.untrusted.add(key(reading));
    later(world, 40 * DAY);
    const outcomes = await settleQuiet(world);
    // The places of the second system have support 40 days old and go quiet; the first system's keep what they have.
    expect(outcomes).not.toContain('refused');
    expect(world.objects.get(semanticKey('planet', secondTopic.id))!.activity).toEqual({
      availability: 'available',
      state: 'quiet',
    });
    expect(world.objects.get(semanticKey('system', secondSystem!))!.activity).toEqual({
      availability: 'available',
      state: 'quiet',
    });
    for (const place of world.objects.values())
      if (place.conceptId === firstTopic.id || place.conceptId === firstSystem)
        expect([place.key, place.activity]).toEqual([place.key, { availability: 'available', state: 'active' }]);
  });

  it('never quiets a system on a partial reading when its places were formed before last supports were stored (2)', async () => {
    // Three systems of fourteen topics each: the reconciliation marks forty-five topics dirty, three runs' worth.
    const synthetic = ['alpha', 'beta', 'gamma'].flatMap((system) => [
      { id: system, parent: null, meaning: `The ${system} system.`, facets: [] },
      ...Array.from({ length: 14 }, (_unused, n) => ({
        id: `${system}.t${String(n).padStart(2, '0')}`,
        parent: system,
        meaning: `Topic ${String(n)} of ${system}.`,
        facets: ['x', 'y', 'z'].map((facet) => ({
          id: `${system}.t${String(n).padStart(2, '0')}.${facet}`,
          meaning: `Facet ${facet}.`,
        })),
      })),
    ]);
    const world = new World({ catalogue: synthetic });
    const planets = synthetic.filter((topic) => topic.parent !== null);
    expect(planets.length).toBeGreaterThanOrEqual(40);
    const oldTopic = planets[0]!.id;
    const age = (days: number) => new Date(Date.parse(world.now) - days * DAY).toISOString();
    world.read(
      ...planets
        .filter((topic) => topic.id !== oldTopic)
        .flatMap((topic) => planetReadings(world.catalogue, topic.id, age(1))),
      ...planetReadings(world.catalogue, oldTopic, age(100)),
    );
    await runRules(world);
    // Places formed before last supports were stored, then the reconciliation marks every topic dirty. The topic with the old
    // reading is the newest dirty one, so a run evaluates it alone, long before the recent topics beside it.
    for (const stored of world.objects.values()) {
      delete stored.lastSupportAt;
      delete stored.quietCheckAt;
    }
    for (const topic of new Set(world.readings.map((reading) => reading.topicId)))
      if (topic !== oldTopic) world.touch(topic);
    world.touch(oldTopic);
    const system = world.objects.get(semanticKey('system', 'alpha'))!;
    const star = world.objects.get(semanticKey('star', 'alpha'))!;
    expect(system.activity).toEqual({ availability: 'available', state: 'active' });
    expect(await runRules(world)).toBeGreaterThanOrEqual(3);
    const flipped = settledOps(world).filter(
      (operation) => operation.kind === 'set_activity' && [system.id, star.id].includes(operation.objectId),
    );
    expect(flipped).toEqual([]);
    expect(world.objects.get(system.key)!.activity).toEqual({ availability: 'available', state: 'active' });
    expect(world.objects.get(system.key)!.lastSupportAt).toBe(age(1));
  });

  it('reads past withdrawn newest keys, so an older trusted key still counts (5)', async () => {
    const world = new World();
    const [first, second] = firstTopic.facets;
    const age = (days: number) => new Date(Date.parse(world.now) - days * DAY).toISOString();
    // Five keys of one facet, the newest three withdrawn; one key of another facet. Whole catalogue: two trusted units in the
    // first facet and one in the second make three units over two facets, a planet.
    world.read(
      ...[5, 4, 3, 2, 1].map((days) => ({
        topicId: firstTopic.id,
        facetId: first!.id,
        unit: `u${String(days)}`,
        at: age(days),
      })),
      { topicId: firstTopic.id, facetId: second!.id, unit: 'v1', at: age(9) },
    );
    for (const days of [3, 2, 1]) world.untrusted.add(`${firstTopic.id}|${first!.id}|u${String(days)}`);
    await runRules(world);
    expect(world.keysOfPlaces()).toEqual(wholeCatalogue(world.readings, world.now, world.untrusted).keys);
    expect(world.objects.has(semanticKey('planet', firstTopic.id))).toBe(true);
    // The planet's last support is its newest trusted key (5 days... the newest of the older ones: 4 days old).
    expect(world.objects.get(semanticKey('planet', firstTopic.id))!.lastSupportAt).toBe(age(4));
  });

  it('keeps a topic dirty, in backoff, while nothing in it is trusted, and judges it when its content is restored (4)', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, firstTopic.id));
    for (const reading of world.readings) world.untrusted.add(key(reading));
    await runRules(world);
    expect(world.dirty.has(firstTopic.id)).toBe(true);
    expect(world.backoff.get(firstTopic.id)!.attempts).toBe(1);
    expect(world.eligibleDirty()).toEqual([]);
    // Content comes back with no mark of its own (a retry finds it); the first retry waits a minute.
    world.untrusted.clear();
    later(world, 30_000);
    await runRules(world);
    expect(world.keysOfPlaces()).toEqual([]);
    later(world, 31_000);
    await runRules(world);
    expect(world.objects.has(semanticKey('planet', firstTopic.id))).toBe(true);
    expect(world.dirty.size).toBe(0);
  });

  it('lets a topic that stays untrusted go after a bounded number of tries; a readmission brings it back (4)', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, firstTopic.id));
    for (const reading of world.readings) world.untrusted.add(key(reading));
    let tries = 0;
    for (; tries < 40 && world.dirty.size > 0; tries++) {
      await runRules(world);
      later(world, 2 * 3_600_000);
    }
    expect(tries).toBe(EVALUATION.untrustedAttempts);
    expect(world.dirty.size).toBe(0);
    // The operator's readmission marks the topics holding the restored units dirty again, out of any backoff.
    world.untrusted.clear();
    world.touch(firstTopic.id);
    await runRules(world);
    expect(world.objects.has(semanticKey('planet', firstTopic.id))).toBe(true);
  });

  it('asks for another run, after a backoff, when an apply is refused: the reading is not lost with it (3)', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, firstTopic.id));
    const ports = world.ports();
    const prepared = await prepareGeography(ports, world.cap(), { kind: 'dirty' });
    if (prepared.kind !== 'prepared') throw new Error('CI expected a context');
    // The content is withdrawn while the run waits: the apply sees other authority than the claim did.
    world.untrusted.add(`${firstTopic.id}|${firstTopic.facets[0]!.id}|${firstTopic.id}:a`);
    const applied = await applyProposal(
      ports,
      world.cap(),
      undefined,
      prepared.context,
      requiredChanges(prepared.context.facts),
      () => Promise.resolve(),
    );
    expect(applied).toMatchObject({ kind: 'refused', reason: 'source_changed', more: true });
    expect(world.dirty.has(firstTopic.id)).toBe(true);
    const waiting = await ports.readDirty(world.cap().personal, { limit: 4 });
    expect(waiting).toMatchObject({ topics: [], nextRetryAt: new Date(Date.parse(world.now) + 60_000).toISOString() });
    // The continuation wakes at the end of the backoff, not before and not on the pace of the last run.
    const wakes: (Date | undefined)[] = [];
    const next = {
      ...ports,
      store: { ...ports.store, writeRun: () => Promise.resolve() },
      enqueue: (_cap: unknown, _id: string, delayed?: { startAfter: Date }) => {
        wakes.push(delayed?.startAfter);
        return Promise.resolve(true);
      },
      enqueueRetirement: () => Promise.resolve(),
    } as unknown as Parameters<typeof continueCartography>[0];
    await continueCartography(next, world.cap(), world.state);
    expect(wakes).toEqual([new Date(waiting.nextRetryAt!)]);
    // Nothing waiting, nothing to continue.
    world.dirty.clear();
    wakes.length = 0;
    await continueCartography(next, world.cap(), world.state);
    expect(wakes).toEqual([]);
  });

  it('backs a place no settle can read off, an hour and doubling, and lets it go after the sixth look (6)', async () => {
    const world = new World();
    // A formed system whose topics have no support at all: its settle reads nothing of it.
    const system = {
      key: semanticKey('system', firstSystem!),
      id: uuid(900),
      kind: 'system' as const,
      conceptId: firstSystem!,
      parentKey: 'universe',
      truthStatus: 'factual' as const,
      labels: ['x'],
      label: 'x',
      objectRevision: 1,
      originTransitionId: uuid(901),
      activity: { availability: 'available' as const, state: 'active' as const },
      quietCheckAt: world.now,
    };
    world.objects.set(system.key, system);
    const settle = settleOf(world);
    const checks: (string | undefined)[] = [];
    for (let look = 0; look < 7; look++) {
      await settle(settleJob([system.id]));
      checks.push(world.objects.get(system.key)!.quietCheckAt);
      later(world, QUIET_SWEEP.parkMs + 1);
    }
    const hours = (check: string | undefined, from: number) =>
      check ? (Date.parse(check) - from) / 3_600_000 : undefined;
    const start = Date.parse(NOW);
    expect(checks.slice(0, 5).map((check, look) => hours(check, start + look * (QUIET_SWEEP.parkMs + 1)))).toEqual([
      1, 2, 4, 8, 16,
    ]);
    expect(checks.slice(5)).toEqual([undefined, undefined]);
  });

  it("samples the reader's other recent topics when nothing trusted was found, so one withdrawn Scroll is not a fault (7)", async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, secondTopic.id));
    await runRules(world);
    world.read(...planetReadings(world.catalogue, firstTopic.id));
    for (const reading of world.readings.filter((entry) => entry.topicId === firstTopic.id))
      world.untrusted.add(key(reading));
    const prepared = await prepareGeography(world.ports(), world.cap(), { kind: 'dirty' });
    if (prepared.kind !== 'prepared') throw new Error('CI expected a context');
    expect(prepared.context.evaluated).toMatchObject({
      topics: [firstTopic.id],
      untrusted: [firstTopic.id],
      otherTrusted: true,
    });
    // The sample changes no fact: nothing of the second system is in the context.
    expect(prepared.context.facts.supports).toEqual([]);
    expect(prepared.context.facts.objects.map((place) => place.conceptId)).not.toContain(secondTopic.id);
    // A reader with nothing trusted anywhere is still the fault it was.
    for (const reading of world.readings) world.untrusted.add(key(reading));
    const none = await prepareGeography(world.ports(), world.cap(), { kind: 'dirty' });
    if (none.kind !== 'prepared') throw new Error('CI expected a context');
    expect(none.context.evaluated?.otherTrusted).toBeUndefined();
  });

  it('takes pages until the backlog is drained, and no more than a bounded number a pass (6)', async () => {
    const calls: { limit: number; runHeldUntil: Date; now: Date }[] = [];
    const sweepOf = (answer: (page: number) => { looked: number; handedOver: number }) =>
      makeSweepQuiet({
        enabled: () => true,
        now: () => new Date(NOW),
        store: {
          handOverDue: (input) => {
            calls.push(input);
            return Promise.resolve(answer(calls.length));
          },
        },
      });
    expect(
      await sweepOf((page) => (page <= 3 ? { looked: 500, handedOver: 480 } : { looked: 120, handedOver: 100 }))(),
    ).toEqual({
      handedOver: 3 * 480 + 100,
    });
    expect(calls).toHaveLength(4);
    // A universe a run holds waits minutes, not a day.
    expect(calls[0]!.runHeldUntil.getTime() - calls[0]!.now.getTime()).toBe(QUIET_SWEEP.runHeldMs);
    calls.length = 0;
    await sweepOf(() => ({ looked: QUIET_SWEEP.batch, handedOver: QUIET_SWEEP.batch }))();
    expect(calls).toHaveLength(QUIET_SWEEP.pagesPerPass);
  });

  it("applies a model's route and label revision on an incremental context exactly as it would on the whole catalogue (4)", async () => {
    const [a, b] = topics.filter((topic) => topic.parent === firstSystem);
    const world = new World();
    world.read(...planetReadings(world.catalogue, a!.id));
    await runRules(world);
    // The second planet is due beside a formed one, so the context holds the first as a neighbour, one key of each facet.
    world.read(...planetReadings(world.catalogue, b!.id));
    const ports = world.ports();
    const prepared = await prepareGeography(ports, world.cap(), { kind: 'dirty' });
    if (prepared.kind !== 'prepared') throw new Error('CI expected a context');
    const { facts } = prepared.context;
    const keyA = semanticKey('planet', a!.id),
      keyB = semanticKey('planet', b!.id);
    const placeA = world.objects.get(keyA)!;
    const refsOf = (topicId: string) =>
      facts.supports.filter((support) => support.topicId === topicId).map((support) => support.ref);
    expect(refsOf(a!.id).length).toBeGreaterThan(0);
    const proposal = {
      version: 'cartographer-proposal.v1' as const,
      operations: [
        ...requiredChanges(facts).operations,
        {
          kind: 'connect_route' as const,
          fromKey: keyA,
          toKey: keyB,
          supportRefs: [...refsOf(a!.id), ...refsOf(b!.id)],
        },
        {
          kind: 'revise_label' as const,
          objectId: placeA.id,
          label: placeA.labels[1]!,
          supportRefs: refsOf(a!.id).slice(0, 1),
        },
      ],
    };
    const applied = await applyProposal(ports, world.cap(), undefined, prepared.context, proposal, () =>
      Promise.resolve(),
    );
    expect(applied.kind).toBe('applied');
    expect(world.objects.get(keyA)!.label).toBe(placeA.labels[1]);
    expect([...world.routes.values()].map((route) => route.id)).toEqual([
      derivedRouteId(ports.mac, world.secret!, keyA, keyB),
    ]);
    expect(world.keysOfPlaces()).toEqual(wholeCatalogue(world.readings, world.now).keys);
  });
});
