import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { requiredChanges } from '../domain/formation.js';
import { derivedPlaceId, derivedRouteId } from '../domain/ids.js';
import { semanticKey, type Place } from '../domain/policy.js';
import { evaluationOf, nothingTrusted, prepareGeography, topicsOfPlaces } from './context.js';
import type { GeographyContext } from './ports.js';
import { NOW, World, coverageOf, planetReadings, unreadable, uuid } from '../adapters/world.fixture.js';

/** Authored readings over the real concept catalogue; none of this is a person's reading. */
const earth = ['earth.seasons', 'earth.tides', 'earth.greenhouse-effect'] as const;
const [seasons, tides, greenhouse] = earth;

const placed = (kind: Place['kind'], conceptId: string, parentKey: string, n: number): Place => ({
  key: semanticKey(kind, conceptId),
  id: uuid(500 + n),
  kind,
  conceptId,
  parentKey,
  truthStatus: 'factual',
  labels: [conceptId],
  label: conceptId,
  objectRevision: 1,
  originTransitionId: uuid(600),
  activity: { availability: 'available', state: 'active' },
});
/** Stores places as a run leaves them: each with the last support it was evaluated with. */
function store(world: World, ...places: Place[]) {
  for (const place of places) world.objects.set(place.key, { ...place, lastSupportAt: NOW });
}
const formedEarth = () => [
  placed('system', 'earth', 'universe', 1),
  placed('star', 'earth', semanticKey('system', 'earth'), 2),
];

async function prepared(world: World, request = { kind: 'dirty' } as Parameters<typeof prepareGeography>[2]) {
  const result = await prepareGeography(world.ports(), world.cap(), request);
  if (result.kind !== 'prepared') throw new Error(`expected a context, got ${result.reason}`);
  return result.context;
}
const keysOf = (context: GeographyContext) => context.facts.candidates.map((candidate) => candidate.key).sort();
const facetsOf = (topicId: string) => CONCEPTS.find((topic) => topic.id === topicId)!.facets.map((facet) => facet.id);

describe('a frozen context holds only what was evaluated (#674, D-416)', () => {
  it('evaluates the dirty topics: candidates for the touched topic, its system and star, and nothing else', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, seasons));
    const context = await prepared(world);
    expect(keysOf(context)).toEqual(
      [
        'system:earth:factual',
        'star:earth:factual',
        'planet:earth.seasons:factual',
        `region:${facetsOf(seasons)[0]}:factual`,
        `region:${facetsOf(seasons)[1]}:factual`,
      ].sort(),
    );
    expect(context.facts.catalogue.map((entry) => entry.id)).toEqual(['earth', 'earth.seasons']);
    // The system is not formed, so its other topics were looked for too (there are none supported).
    expect(context.evaluated).toEqual({
      topics: [seasons],
      dirtyThrough: world.revision,
      hasMore: false,
      systemsRead: ['earth'],
    });
  });

  it('does not grow with the catalogue or with what was read before: one dirty topic reads one topic', async () => {
    const world = new World();
    for (const topic of CONCEPTS.filter((entry) => entry.parent !== null))
      world.read(...planetReadings(world.catalogue, topic.id));
    world.dirty.clear();
    world.dirty.set(seasons, world.revision + 1);
    world.revision += 1;
    // Everything under Earth that the rules entitle is formed, so a reading of Seasons changes only its own topic.
    store(
      world,
      ...formedEarth(),
      placed('planet', seasons, semanticKey('system', 'earth'), 3),
      ...facetsOf(seasons).map((facet, n) => placed('region', facet, semanticKey('planet', seasons), 4 + n)),
    );
    const context = await prepared(world);
    expect(CONCEPTS.length).toBeGreaterThan(20);
    expect(context.facts.candidates).toHaveLength(3 + facetsOf(seasons).length);
    expect(context.facts.catalogue.map((entry) => entry.id)).toEqual(['earth', seasons]);
    expect(world.counters.inputReads).toEqual([{ topicIds: [seasons], maxTopics: undefined }]);
    expect(context.facts.supports.every((support) => support.topicId === seasons)).toBe(true);
  });

  it('keeps a formed place and its parents even when no support is left under it', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, seasons));
    world.dirty.clear();
    const blackHoles = 'space.black-holes';
    const objects = [
      placed('system', 'space', 'universe', 1),
      placed('star', 'space', semanticKey('system', 'space'), 2),
      placed('planet', blackHoles, semanticKey('system', 'space'), 3),
      placed('region', facetsOf(blackHoles)[0]!, semanticKey('planet', blackHoles), 4),
    ];
    store(world, ...objects);
    world.dirty.set(blackHoles, world.revision + 1);
    const context = await prepared(world);
    const keys = keysOf(context);
    for (const object of objects) {
      expect(keys).toContain(object.key);
      expect(context.facts.candidates.find((c) => c.key === object.key)?.id).toBe(object.id);
    }
    expect(context.facts.supports).toEqual([]);
    expect(context.facts.catalogue.map((entry) => entry.id)).toEqual(expect.arrayContaining(['space', blackHoles]));
  });

  it('reads the other supported topics of a system that is not formed, to count the units under it', async () => {
    const world = new World();
    // One unit under Seasons and one under Tides: neither topic alone makes the system, the two together do.
    world.read({ topicId: seasons, facetId: facetsOf(seasons)[0]!, unit: 'only-seasons' });
    world.dirty.clear();
    world.read({ topicId: tides, facetId: facetsOf(tides)[0]!, unit: 'only-tides' });
    const context = await prepared(world);
    // Tides was evaluated; Seasons was read beside it, one key of each facet, and stays as dirty as it was.
    expect(context.evaluated).toMatchObject({ topics: [tides], neighbours: [seasons] });
    expect(context.facts.supports.map((support) => support.explanationUnitId).sort()).toEqual([
      'only-seasons',
      'only-tides',
    ]);
    expect(requiredChanges(context.facts).operations.map((operation) => operation.kind)).toEqual([
      'create_system',
      'establish_star',
    ]);
    expect(world.counters.inputReads.some((read) => read.maxTopics === 8)).toBe(true);
    // Only the touched topic was dirty; the neighbour was read, not the whole catalogue.
    expect(world.counters.inputReads.every((read) => read.topicIds.length <= 3)).toBe(true);
  });

  it('reads no neighbour once the system is formed and nothing new is due beside it', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, greenhouse));
    world.dirty.clear();
    store(world, ...formedEarth());
    world.read({ topicId: seasons, facetId: facetsOf(seasons)[0]!, unit: 'one' });
    const context = await prepared(world);
    expect(context.evaluated!.topics).toEqual([seasons]);
    expect(world.counters.inputReads).toHaveLength(1);
  });

  it('reads the planets already formed beside a planet that is due, so a route can join them', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, greenhouse));
    world.dirty.clear();
    store(world, ...formedEarth(), placed('planet', greenhouse, semanticKey('system', 'earth'), 3));
    world.read(...planetReadings(world.catalogue, seasons));
    const context = await prepared(world);
    expect(context.evaluated).toMatchObject({ topics: [seasons], neighbours: [greenhouse] });
    expect(context.facts.objects.map((place) => place.kind).sort()).toEqual(['planet', 'star', 'system']);
    expect(requiredChanges(context.facts).operations.map((operation) => operation.kind)).toContain('form_planet');
  });

  it('applies the rules to what a context holds exactly as it did to the whole catalogue', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, seasons), ...planetReadings(world.catalogue, tides));
    const context = await prepared(world);
    const operations = requiredChanges(context.facts).operations;
    expect(operations.filter((operation) => operation.kind === 'form_planet')).toHaveLength(2);
    expect(operations.filter((operation) => operation.kind === 'create_system')).toHaveLength(1);
  });

  it('freezes the proof of each support without its certificate, a few hundred bytes a support', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, seasons));
    const context = await prepared(world);
    expect(context.coverage.availability).toBe('available');
    expect(context.coverage.certificates).toEqual([]);
    expect(context.coverage.witnesses).toHaveLength(3);
    expect(JSON.stringify(context).length).toBeLessThan(20_000);
  });

  it('reads a context frozen before incremental evaluation as the topics it held', () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, seasons));
    store(world, placed('planet', tides, semanticKey('system', 'earth'), 9));
    const old = {
      scopeRevision: 7,
      facts: {
        supports: [{ topicId: seasons }, { topicId: seasons }],
        objects: [world.objects.get(semanticKey('planet', tides))],
      },
    } as unknown as GeographyContext;
    expect(evaluationOf(old)).toEqual({ topics: [seasons, tides].sort(), dirtyThrough: 7, hasMore: false });
  });
});

describe('the ids of new places and routes (D-416)', () => {
  const secretA = 'a'.repeat(64);
  const secretB = 'b'.repeat(64);

  it('derives one id per place from the universe secret and the key, the same on every evaluation', async () => {
    const world = new World({ secret: secretA });
    world.read(...planetReadings(world.catalogue, seasons));
    const first = await prepared(world);
    const second = await prepared(world);
    expect(second.facts.candidates).toEqual(first.facts.candidates);
    for (const candidate of first.facts.candidates)
      expect(candidate.id).toBe(derivedPlaceId(world.ports().mac, secretA, candidate.key));
    expect(new Set(first.facts.candidates.map((candidate) => candidate.id)).size).toBe(first.facts.candidates.length);
  });

  it('is a UUID that reveals nothing without the secret: another secret derives other ids, and an unsalted hash is not it', async () => {
    const a = new World({ secret: secretA }),
      b = new World({ secret: secretB });
    for (const world of [a, b]) world.read(...planetReadings(world.catalogue, seasons));
    const [x, y] = [await prepared(a), await prepared(b)];
    for (const [i, candidate] of x.facts.candidates.entries()) {
      expect(candidate.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(candidate.id).not.toBe(y.facts.candidates[i]!.id);
      expect(candidate.id).not.toContain(candidate.key);
    }
    const mac = a.ports().mac;
    expect(derivedPlaceId(mac, secretA, 'planet:earth.seasons:factual')).not.toBe(
      derivedPlaceId(mac, secretA, 'planet:earth.tides:factual'),
    );
  });

  it('creates the secret at the first run and keeps it', async () => {
    const world = new World();
    expect(world.secret).toBeUndefined();
    world.read(...planetReadings(world.catalogue, seasons));
    const first = await prepared(world);
    expect(world.secret).toMatch(/^[0-9a-f]{64}$/);
    const kept = world.secret;
    expect(await prepared(world)).toMatchObject({ facts: { candidates: first.facts.candidates } });
    expect(world.secret).toBe(kept);
  });

  it('writes nothing for a read-only scope: a universe with no secret yet gets an unsaved one', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, seasons));
    const result = await prepareGeography(world.ports(), world.cap(), { kind: 'dirty' }, { readOnly: true });
    expect(result.kind).toBe('prepared');
    expect(world.secret).toBeUndefined();
  });

  it('keeps the id a place was stored with, whatever the secret says', async () => {
    const world = new World({ secret: secretA });
    world.read(...planetReadings(world.catalogue, seasons));
    store(world, ...formedEarth());
    const context = await prepared(world);
    for (const stored of formedEarth())
      expect(context.facts.candidates.find((candidate) => candidate.key === stored.key)?.id).toBe(stored.id);
  });

  it('derives a route id from the sorted pair of planets, so either end names the same route', () => {
    const mac = new World().ports().mac;
    const a = semanticKey('planet', seasons),
      b = semanticKey('planet', tides);
    expect(derivedRouteId(mac, secretA, a, b)).toBe(derivedRouteId(mac, secretA, b, a));
    expect(derivedRouteId(mac, secretA, a, b)).not.toBe(derivedRouteId(mac, secretB, a, b));
    expect(derivedRouteId(mac, secretA, a, b)).not.toBe(derivedPlaceId(mac, secretA, `${a}|${b}`));
  });
});

describe('why a context was not prepared (#674, D-416)', () => {
  it('stops at no_support_yet for a reader with no references, before reading coverage or allocating an id', async () => {
    const world = new World();
    expect(await prepareGeography(world.ports(), world.cap(), { kind: 'dirty' })).toEqual({
      kind: 'unavailable',
      reason: 'no_support_yet',
    });
    expect(world.counters.trustedReads).toBe(0);
    expect(world.secret).toBeUndefined();
  });

  it('is a context with nothing in it when something was read and nothing changed since', async () => {
    const world = new World();
    world.read(...planetReadings(world.catalogue, seasons));
    world.dirty.clear();
    const context = await prepared(world);
    expect(context.facts.supports).toEqual([]);
    expect(context.evaluated).toMatchObject({ topics: [], hasMore: false });
    expect(requiredChanges(context.facts).operations).toEqual([]);
    expect(world.counters.trustedReads).toBe(0);
  });

  it('names each refusal apart', async () => {
    const readings = [{ topicId: seasons, facetId: facetsOf(seasons)[0]!, unit: 'u' }];
    const refusal = async (world: World) => prepareGeography(world.ports(), world.cap(), { kind: 'dirty' });
    const withReading = (options: ConstructorParameters<typeof World>[0] = {}) => {
      const world = new World(options);
      world.read(...readings);
      return world;
    };
    // Nothing trusted is a complete answer, not a refusal: a context with no support, which the run records as such.
    const untrusted = await refusal(withReading({ trusted: () => unreadable('not_observed') }));
    if (untrusted.kind !== 'prepared') throw new Error('CI expected a context with nothing in it');
    expect(nothingTrusted(untrusted.context)).toBe(true);
    expect(untrusted.context.facts.supports).toEqual([]);
    expect(untrusted.context.evaluated).toMatchObject({ topics: [seasons] });
    // A refusal names what the run tried, so the claim can keep those topics dirty in backoff and ask for another run.
    const attempted = { topics: [seasons], dirtyThrough: 2 };
    expect(await refusal(withReading({ trusted: () => unreadable('authority_changed') }))).toEqual({
      kind: 'unavailable',
      reason: 'coverage_authority_changed',
      attempted,
    });
    expect(await refusal(withReading({ trusted: () => unreadable('limit') }))).toEqual({
      kind: 'unavailable',
      reason: 'coverage_limit',
      attempted,
    });
    const crowded = withReading();
    for (let n = 0; n < 1001; n++)
      crowded.objects.set(`planet:filler-${n}:factual`, placed('planet', `filler-${n}`, 'system:earth:factual', n));
    expect(await refusal(crowded)).toEqual({ kind: 'unavailable', reason: 'structure_limit' });
  });

  it('splits a batch the trusted read cannot hold, and reports a single probe it cannot hold', async () => {
    const world = new World({
      trusted: (probes) =>
        probes.length > 1
          ? unreadable('limit')
          : coverageOf(
              new World().catalogue,
              [
                {
                  topicId: probes[0]!.topicId,
                  facetId: probes[0]!.facetId,
                  unit: probes[0]!.explanationUnitId,
                  at: NOW,
                },
              ],
              0,
            ),
    });
    world.read(...planetReadings(world.catalogue, seasons));
    expect((await prepared(world)).facts.supports.length).toBe(3);
    expect(world.counters.trustedReads).toBeGreaterThan(1);
  });

  it('takes fewer dirty topics when a context would be too large, and leaves the rest dirty for the next run', async () => {
    const world = new World({ padding: 20_000 });
    const planets = CONCEPTS.filter((topic) => topic.parent !== null).slice(0, 12);
    for (const topic of planets) world.read(...planetReadings(world.catalogue, topic.id));
    const context = await prepared(world);
    expect(context.evaluated!.topics.length).toBeGreaterThan(0);
    expect(context.evaluated!.topics.length).toBeLessThan(12);
    expect(context.evaluated!.hasMore).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThanOrEqual(500_000);
    // What it did not take is still dirty.
    expect(world.dirty.size).toBe(12);
  });

  it('refuses a single topic that is too large for one frozen context', async () => {
    const world = new World({ padding: 400_000 });
    world.read(...planetReadings(world.catalogue, seasons));
    expect(await prepareGeography(world.ports(), world.cap(), { kind: 'dirty' })).toEqual({
      kind: 'unavailable',
      reason: 'context_too_large',
      attempted: { topics: [seasons], dirtyThrough: 2 },
    });
  });

  it('takes at most one run of dirty topics, newest first, and says when more are waiting', async () => {
    const world = new World();
    const planets = CONCEPTS.filter((topic) => topic.parent !== null);
    expect(planets.length).toBeGreaterThan(16);
    for (const topic of planets) world.read({ topicId: topic.id, facetId: topic.facets[0]!.id, unit: 'u' });
    const context = await prepared(world);
    expect(context.evaluated!.hasMore).toBe(true);
    // The newest reading is among those taken.
    expect(context.evaluated!.topics).toContain(planets.at(-1)!.id);
  });
});

describe('the topics a due place is read through (the quiet settle)', () => {
  it('names the topic of a planet or a region, and the supported topics of a system or star', async () => {
    const world = new World();
    world.read(
      { topicId: seasons, facetId: facetsOf(seasons)[0]!, unit: 'a' },
      { topicId: tides, facetId: facetsOf(tides)[0]!, unit: 'b' },
    );
    const ports = world.ports();
    const scope = world.cap().personal;
    const planet = placed('planet', seasons, semanticKey('system', 'earth'), 1);
    const region = placed('region', facetsOf(tides)[0]!, semanticKey('planet', tides), 2);
    const system = placed('system', 'earth', 'universe', 3);
    expect(await topicsOfPlaces(ports, scope, [planet])).toEqual([seasons]);
    expect(await topicsOfPlaces(ports, scope, [region])).toEqual([tides]);
    expect(await topicsOfPlaces(ports, scope, [system])).toEqual([seasons, tides]);
    expect(await topicsOfPlaces(ports, scope, [planet, region])).toEqual([seasons, tides]);
  });
});
