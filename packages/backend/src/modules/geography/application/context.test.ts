import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@knowscroll/scroll-model';
import { CONCEPTS, CONCEPT_CATALOGUE_VERSION } from '../../content/public.js';
import type { RecordingScopeTx } from '../../identity/public.js';
import { requiredChanges } from '../domain/formation.js';
import { semanticKey, type Candidate, type FormationFacts, type Place } from '../domain/policy.js';
import { prepareGeography } from './context.js';
import type { GeographyContext, GeographyPorts, GeographyView } from './ports.js';

/** Authored readings over the real concept catalogue; none of this is a person's reading. */
interface Reading {
  readonly topicId: string;
  readonly facetId: string;
  readonly unit: string;
  readonly at?: string;
}
const NOW = '2026-10-20T00:00:00.000Z';
const RECENT = '2026-10-19T00:00:00.000Z';
const hash = (value: unknown) => canonicalSha256(value);
const truthSha256 = hash({ kind: 'factual' });
const uuid = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const topicOf = (id: string) => CONCEPTS.find((topic) => topic.id === id)!;

const earth = ['earth.seasons', 'earth.tides', 'earth.greenhouse-effect'] as const;
const facetOf = (topicId: string, n: number) => topicOf(topicId).facets[n]!.id;
/** Three distinct units over two facets: enough for the rules to form the planet. */
const due = (topicId: string): Reading[] => [
  { topicId, facetId: facetOf(topicId, 0), unit: `${topicId}:a` },
  { topicId, facetId: facetOf(topicId, 1), unit: `${topicId}:b` },
  { topicId, facetId: facetOf(topicId, 0), unit: `${topicId}:c` },
];
/** Not enough for a planet. */
const thin = (topicId: string): Reading[] => [{ topicId, facetId: facetOf(topicId, 0), unit: `${topicId}:a` }];

function coverageOf(readings: readonly Reading[]) {
  const rows = readings.map((reading) => {
    const topic = topicOf(reading.topicId);
    const facet = topic.facets.find((entry) => entry.id === reading.facetId)!;
    const support = {
      topicId: reading.topicId,
      facetId: reading.facetId,
      meaningSha256: hash({
        topicId: topic.id,
        topicMeaning: topic.meaning,
        facetId: facet.id,
        facetMeaning: facet.meaning,
      }),
      explanationUnitId: reading.unit,
      truthSha256,
    };
    const witnessKey = hash(reading);
    const identity = {
      sourceKind: 'segment' as const,
      recordingGeneration: 1,
      activityId: uuid(1),
      qualificationId: uuid(2),
      certificateSha256: hash({ witnessKey }),
    };
    const exposureId = `0199a000-0000-7000-9000-${witnessKey.slice(0, 12)}`;
    return {
      support: { ...support, witnessExposureIds: [exposureId] },
      witness: { ...support, ...identity, exposureId, witnessKey },
      certificate: {
        witnessKey,
        ...identity,
        certificate: {
          exposureId,
          availability: 'available',
          explanationUnitId: reading.unit,
          activatedAt: reading.at ?? RECENT,
          mapping: { framing: 'factual', catalogueVersion: CONCEPT_CATALOGUE_VERSION, framingSha256: truthSha256 },
        },
      },
    };
  });
  return {
    version: 'trusted-coverage-read.v1',
    completeness: 'not_asserted',
    supportedFormats: ['scroll'],
    availability: 'available',
    reason: 'current',
    supports: rows.map((row) => row.support),
    witnesses: rows.map((row) => row.witness),
    certificates: rows.map((row) => row.certificate),
  };
}

const unreadable = (reason: 'limit' | 'authority_changed' | 'not_observed') => ({
  version: 'trusted-coverage-read.v1',
  completeness: 'not_asserted',
  supportedFormats: ['scroll'],
  availability: 'unavailable',
  reason,
  supports: [],
  witnesses: [],
  certificates: [],
});

interface Counters {
  trustedReads: number;
  ids: number;
}
function portsFor(
  readings: readonly Reading[],
  options: {
    discovery?: Record<string, unknown>;
    trusted?: (probes: readonly unknown[]) => unknown;
  } = {},
): { ports: GeographyPorts; counters: Counters } {
  const counters: Counters = { trustedReads: 0, ids: 0 };
  const probes = [
    ...new Map(
      readings.map((r) => [
        `${r.topicId}|${r.facetId}|${r.unit}`,
        { topicId: r.topicId, facetId: r.facetId, explanationUnitId: r.unit },
      ]),
    ).values(),
  ];
  const ports = {
    store: { root: () => Promise.resolve({ accountId: uuid(9), revision: 1 }) },
    readInputs: () =>
      Promise.resolve({
        revision: 1,
        completeness: 'not_asserted',
        availability: 'available',
        reason: 'bounded',
        probes,
        ...options.discovery,
      }),
    readTrusted: (
      _scope: unknown,
      query: { probes: readonly { topicId: string; facetId: string; explanationUnitId: string }[] },
    ) => {
      counters.trustedReads++;
      if (options.trusted) return Promise.resolve(options.trusted(query.probes));
      const wanted = readings.filter((r) =>
        query.probes.some((p) => p.topicId === r.topicId && p.facetId === r.facetId && p.explanationUnitId === r.unit),
      );
      return Promise.resolve(wanted.length ? coverageOf(wanted) : unreadable('not_observed'));
    },
    hash,
    newId: () => uuid(1000 + counters.ids++),
    now: () => new Date(NOW),
  } as unknown as GeographyPorts;
  return { ports, counters };
}

const scope = {
  personal: { authority: { universeId: uuid(7), privacyEpoch: 1 }, revisionAtEntry: 3 },
} as unknown as RecordingScopeTx;
const view = (objects: readonly Place[] = [], extra: Partial<GeographyView> = {}): GeographyView => ({
  state: {
    revision: 4,
    structureRevision: 4,
    activityRevision: 4,
    desiredRevision: 5,
    materialRevision: 5,
    publishedRevision: 4,
  },
  objects,
  routes: [],
  aliases: [],
  ...extra,
});
const place = (kind: Place['kind'], conceptId: string, parentKey: string, n: number): Place => ({
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

async function prepared(
  ports: GeographyPorts,
  objects: readonly Place[] = [],
  previous?: GeographyContext,
): Promise<GeographyContext> {
  const result = await prepareGeography(ports, scope, view(objects), previous);
  if (result.kind !== 'prepared') throw new Error(`expected a context, got ${result.reason}`);
  return result.context;
}
const keysOf = (candidates: readonly Candidate[]) => candidates.map((candidate) => candidate.key).sort();

/** Every concept as a candidate, the layout every context had before relevance (#674). */
function wholeCatalogueFacts(facts: FormationFacts): FormationFacts {
  const slot = (kind: Candidate['kind'], conceptId: string, parentKey: string, n: number): Candidate => ({
    key: semanticKey(kind, conceptId),
    id: uuid(2000 + n),
    kind,
    conceptId,
    parentKey,
    truthStatus: 'factual',
    labels: [facts.candidates.find((c) => c.conceptId === conceptId)?.labels[0] ?? conceptId],
  });
  const named = new Map(facts.candidates.map((candidate) => [candidate.key, candidate]));
  const all = CONCEPTS.flatMap((topic, index): Candidate[] =>
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
  ).map((candidate) => named.get(candidate.key) ?? candidate);
  return {
    ...facts,
    catalogue: CONCEPTS.map((topic) => ({ id: topic.id, parent: topic.parent, facets: topic.facets.map((f) => f.id) })),
    candidates: all,
  };
}

describe('a frozen context holds only what the person has reached (#674)', () => {
  it('builds candidates for the concepts that have support, with their system and star', async () => {
    const { ports } = portsFor(due('earth.seasons'));
    const context = await prepared(ports);
    expect(keysOf(context.facts.candidates)).toEqual(
      [
        'system:earth:factual',
        'star:earth:factual',
        'planet:earth.seasons:factual',
        `region:${facetOf('earth.seasons', 0)}:factual`,
        `region:${facetOf('earth.seasons', 1)}:factual`,
      ].sort(),
    );
    expect(context.facts.catalogue).toEqual([
      { id: 'earth', parent: null, facets: [] },
      { id: 'earth.seasons', parent: 'earth', facets: topicOf('earth.seasons').facets.map((facet) => facet.id) },
    ]);
  });

  it('does not grow with the catalogue: the slots are the supported concepts, never every concept', async () => {
    const { ports } = portsFor(thin('earth.seasons'));
    const context = await prepared(ports);
    const wholeCatalogue = wholeCatalogueFacts(context.facts).candidates.length;
    expect(wholeCatalogue).toBeGreaterThan(80);
    expect(context.facts.candidates.length).toBeLessThanOrEqual(5);
    expect(context.facts.catalogue.length).toBeLessThanOrEqual(2);
  });

  it('keeps a formed place and its parents even when no support is left under it', async () => {
    const objects = [
      place('system', 'space', 'universe', 1),
      place('star', 'space', semanticKey('system', 'space'), 2),
      place('planet', 'space.black-holes', semanticKey('system', 'space'), 3),
      place('region', facetOf('space.black-holes', 0), semanticKey('planet', 'space.black-holes'), 4),
    ];
    const { ports } = portsFor(thin('earth.seasons'));
    const context = await prepared(ports, objects);
    const keys = keysOf(context.facts.candidates);
    for (const object of objects) expect(keys).toContain(object.key);
    expect(context.facts.catalogue.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(['space', 'space.black-holes', 'earth', 'earth.seasons']),
    );
    // The formed ids are the stored ones, so a later run can find them.
    for (const object of objects)
      expect(context.facts.candidates.find((c) => c.key === object.key)?.id).toBe(object.id);
  });

  it('allocates route ids only for pairs of formed or due planets of one system', async () => {
    const [seasons, tides, greenhouse] = earth;
    const space = topicOf('space.black-holes');
    const objects = [
      place('system', 'earth', 'universe', 1),
      place('star', 'earth', semanticKey('system', 'earth'), 2),
      place('planet', greenhouse, semanticKey('system', 'earth'), 3),
    ];
    // Seasons and Tides are due, Greenhouse is formed, and a planet of another system is due as well.
    const readings = [...due(seasons), ...due(tides), ...thin(greenhouse), ...due(space.id)];
    const { ports } = portsFor(readings);
    const context = await prepared(ports, objects);
    const pair = (a: string, b: string) => [semanticKey('planet', a), semanticKey('planet', b)].sort().join('|');
    expect(Object.keys(context.routeIds).sort()).toEqual(
      [pair(seasons, tides), pair(seasons, greenhouse), pair(tides, greenhouse)].sort(),
    );
    expect(new Set(Object.values(context.routeIds)).size).toBe(3);
  });

  it('allocates no route id for planets that are neither formed nor due', async () => {
    const [seasons, tides] = earth;
    const { ports } = portsFor([...thin(seasons), ...thin(tides)]);
    expect((await prepared(ports)).routeIds).toEqual({});
  });

  it('asks the rules for exactly what it asked before, on the same reading', async () => {
    const [seasons, tides] = earth;
    const objects = [
      place('system', 'earth', 'universe', 1),
      place('star', 'earth', semanticKey('system', 'earth'), 2),
      place('planet', seasons, semanticKey('system', 'earth'), 3),
      place('region', facetOf(seasons, 0), semanticKey('planet', seasons), 4),
    ];
    // Seasons was formed and its newest support is now 40 days old, Tides and a second system are due.
    const old = '2026-09-01T00:00:00.000Z';
    const readings = [
      ...due(seasons).map((reading) => ({ ...reading, at: old })),
      ...due(tides),
      ...due('space.black-holes'),
    ];
    const { ports } = portsFor(readings);
    const context = await prepared(ports, objects);
    const whole = wholeCatalogueFacts(context.facts);
    const slice = requiredChanges(context.facts).operations;
    expect(slice.length).toBeGreaterThan(4);
    expect(slice.some((operation) => operation.kind === 'set_activity')).toBe(true);
    expect(slice).toEqual(requiredChanges(whole).operations);
  });

  it('keeps the ids a previous context allocated, and takes a concept that reading has reached since without refusing', async () => {
    const [seasons, tides] = earth;
    const first = await prepared(portsFor([...thin(seasons)]).ports);
    // The catalogue is the same; Tides is new to the slice because the person has since reached it.
    const { ports, counters } = portsFor([...due(seasons), ...thin(tides)]);
    const next = await prepared(ports, [], first);
    for (const candidate of first.facts.candidates)
      expect(next.facts.candidates.find((c) => c.key === candidate.key)?.id).toBe(candidate.id);
    const added = next.facts.candidates.filter((c) => !first.facts.candidates.some((old) => old.key === c.key));
    expect(added.map((c) => c.conceptId)).toEqual(expect.arrayContaining([tides]));
    expect(counters.ids).toBeGreaterThan(0);
  });
});

describe('why a context was not prepared (#674)', () => {
  it('stops at no_support_yet for a reader with no references, before reading coverage or allocating an id', async () => {
    const { ports, counters } = portsFor([]);
    expect(await prepareGeography(ports, scope, view())).toEqual({ kind: 'unavailable', reason: 'no_support_yet' });
    expect(counters).toEqual({ trustedReads: 0, ids: 0 });
  });

  it('names each other refusal apart', async () => {
    const reading = thin('earth.seasons');
    const refusal = async (ports: GeographyPorts, structure?: Partial<GeographyView>) =>
      prepareGeography(ports, scope, view([], structure));
    expect(
      await refusal(
        portsFor(reading, { discovery: { availability: 'unavailable', reason: 'limit', probes: [] } }).ports,
      ),
    ).toEqual({
      kind: 'unavailable',
      reason: 'discovery_limit',
    });
    expect(await refusal(portsFor(reading, { trusted: () => unreadable('not_observed') }).ports)).toEqual({
      kind: 'unavailable',
      reason: 'no_trusted_support',
    });
    expect(await refusal(portsFor(reading, { trusted: () => unreadable('authority_changed') }).ports)).toEqual({
      kind: 'unavailable',
      reason: 'coverage_authority_changed',
    });
    expect(await refusal(portsFor(reading, { trusted: () => unreadable('limit') }).ports)).toEqual({
      kind: 'unavailable',
      reason: 'coverage_limit',
    });
    const routes = Array.from({ length: 1001 }, (_, n) => ({ id: uuid(n) })) as never;
    expect(await refusal(portsFor(reading).ports, { routes })).toEqual({
      kind: 'unavailable',
      reason: 'structure_limit',
    });
  });

  it('splits a batch the trusted read cannot hold, and reports a single probe it cannot hold', async () => {
    const [seasons, tides] = earth;
    const readings = [...thin(seasons), ...thin(tides)];
    const single = portsFor(readings, {
      trusted: (probes) => (probes.length > 1 ? unreadable('limit') : coverageOf(readings.slice(0, 1))),
    });
    expect((await prepared(single.ports)).facts.supports.length).toBeGreaterThan(0);
    expect(single.counters.trustedReads).toBeGreaterThan(1);
  });

  it('refuses a context larger than one frozen context holds', async () => {
    const long = 'x'.repeat(160);
    const objects = Array.from({ length: 1000 }, (_, n) => ({
      ...place('planet', 'earth.seasons', semanticKey('system', 'earth'), n),
      key: `planet:filler-${n}:factual`,
      conceptId: `filler-${n}`,
      labels: [long, long, long],
    }));
    const { ports } = portsFor(thin('earth.seasons'));
    expect(await prepareGeography(ports, scope, view(objects))).toEqual({
      kind: 'unavailable',
      reason: 'context_too_large',
    });
  });
});
