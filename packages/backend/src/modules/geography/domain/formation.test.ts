import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { EVALUATION, newestKeysPerFacet } from './evaluation.js';
import { placesDue, reconcileWithRules, requiredChanges } from './formation.js';
import {
  FORMATION,
  MAX_PROPOSAL_OPERATIONS,
  PROOF_REFS,
  activityFor,
  formationEligible,
  proposalIssue,
  semanticKey,
  type Candidate,
  type FormationFacts,
  type GeographyProposal,
  type Place,
  type Support,
} from './policy.js';

/** Authored supports over the real concept catalogue; none of this is a person's reading. */
const catalogue = CONCEPTS.map((topic) => ({
  id: topic.id,
  parent: topic.parent,
  facets: topic.facets.map((facet) => facet.id),
}));
const candidates: Candidate[] = CONCEPTS.flatMap((topic, index): Candidate[] => {
  const slot = (kind: Candidate['kind'], conceptId: string, parentKey: string, n: number): Candidate => ({
    key: semanticKey(kind, conceptId),
    id: `10000000-0000-4000-8000-${String(index * 100 + n).padStart(12, '0')}`,
    kind,
    conceptId,
    parentKey,
    truthStatus: 'factual',
    labels: [conceptId, `${conceptId} (canonical meaning)`],
  });
  if (topic.parent === null)
    return [slot('system', topic.id, 'universe', 0), slot('star', topic.id, semanticKey('system', topic.id), 1)];
  return [
    slot('planet', topic.id, semanticKey('system', topic.parent), 0),
    ...topic.facets.map((facet, n) => slot('region', facet.id, semanticKey('planet', topic.id), n + 1)),
  ];
});
const seasons = 'earth.seasons';
const tilt = `${seasons}.axial-tilt`;
const hemispheres = `${seasons}.hemispheres`;
const limits = `${seasons}.limits`;

const NOW = '2026-10-20T00:00:00.000Z';
const support = (
  unit: string,
  facetId = tilt,
  topicId = seasons,
  activatedAt = '2026-10-19T00:00:00.000Z',
): Support => ({
  ref: `${topicId}:${unit}:${facetId}`,
  topicId,
  facetId,
  explanationUnitId: unit,
  truthStatus: 'factual',
  activatedAt,
});
const facts = (supports: Support[], objects: Place[] = []): FormationFacts => ({
  catalogue,
  supports,
  candidates,
  objects,
  routes: [],
  evaluatedAt: NOW,
  completeness: 'not_asserted',
});
const kindsOf = (proposal: GeographyProposal) => proposal.operations.map((operation) => operation.kind);

describe('what the formation rules require, without a model', () => {
  it('forms nothing from one unit, a system and star from two, and a planet with regions from three over two facets', () => {
    expect(requiredChanges(facts([support('a')])).operations).toEqual([]);
    expect(kindsOf(requiredChanges(facts([support('a'), support('b')])))).toEqual(['create_system', 'establish_star']);
    const three = requiredChanges(facts([support('a'), support('b', hemispheres), support('c')]));
    expect(kindsOf(three)).toEqual(['create_system', 'establish_star', 'form_planet', 'add_region', 'add_region']);
  });

  it('asks for a model only while a place is due, never for activity alone or for nothing', () => {
    expect(placesDue(facts([support('a')]))).toBe(false);
    expect(placesDue(facts([support('a'), support('b')]))).toBe(true);
    const established = requiredChanges(facts([support('a'), support('b')])).operations.map((operation) => {
      const candidate = candidates.find((c) => 'key' in operation && c.key === operation.key)!;
      return {
        ...candidate,
        label: candidate.labels[0]!,
        objectRevision: 1,
        originTransitionId: 'earlier',
        activity: { availability: 'available' as const, state: 'quiet' as const },
      };
    });
    const later = facts([support('a'), support('b')], established);
    expect(requiredChanges(later).operations.map((operation) => operation.kind)).toEqual([
      'set_activity',
      'set_activity',
    ]);
    expect(placesDue(later)).toBe(false);
  });
  it('never forms a planet from three units over one facet', () => {
    const proposal = requiredChanges(facts([support('a'), support('b'), support('c')]));
    expect(kindsOf(proposal)).toEqual(['create_system', 'establish_star']);
  });

  it('never forms a planet from three units spread over three planets of one system', () => {
    const proposal = requiredChanges(
      facts([
        support('a'),
        support('b', 'earth.tides.forcing', 'earth.tides'),
        support('c', 'earth.greenhouse-effect.radiation', 'earth.greenhouse-effect'),
      ]),
    );
    expect(kindsOf(proposal)).toEqual(['create_system', 'establish_star']);
  });

  it('forms no system from single units in three different systems', () => {
    const other = CONCEPTS.find((topic) => topic.parent !== null && topic.parent !== 'earth')!;
    const third = CONCEPTS.find((topic) => topic.parent !== null && !['earth', other.parent].includes(topic.parent))!;
    const proposal = requiredChanges(
      facts([support('a'), support('b', other.facets[0]!.id, other.id), support('c', third.facets[0]!.id, third.id)]),
    );
    expect(proposal.operations).toEqual([]);
  });

  it('uses canonical labels and cites only supports under the place', () => {
    const f = facts([
      support('a'),
      support('b', hemispheres),
      support('c', limits),
      support('d', 'earth.tides.forcing', 'earth.tides'),
    ]);
    const planet = requiredChanges(f).operations.find((operation) => operation.kind === 'form_planet');
    expect(planet).toMatchObject({ key: semanticKey('planet', seasons), label: seasons });
    expect(planet && 'supportRefs' in planet ? planet.supportRefs : []).not.toContain(
      'earth.tides:d:earth.tides.forcing',
    );
  });

  test.prop([
    fc.array(
      fc.record({
        unit: fc.constantFrom('u1', 'u2', 'u3', 'u4', 'u5', 'u6'),
        topic: fc.constantFrom(...CONCEPTS.filter((topic) => topic.parent !== null)),
        facet: fc.nat(2),
      }),
      { maxLength: 24 },
    ),
  ])('every required change validates against the same rules a model proposal must pass', (picks) => {
    // Coverage holds one support per topic, facet and unit, so repeated picks collapse to one.
    const byRef = new Map(
      picks
        .map(({ unit, topic, facet }) => support(unit, topic.facets[facet % topic.facets.length]!.id, topic.id))
        .map((entry) => [entry.ref, entry] as const),
    );
    const supports = [...byRef.values()];
    const f = facts(supports);
    const proposal = requiredChanges(f);
    expect(proposal.operations.length).toBeLessThanOrEqual(MAX_PROPOSAL_OPERATIONS);
    expect(proposalIssue(proposal, f)).toBeUndefined();
  });

  it('changes only activity for a place once established, and never removes one', () => {
    const f = facts([
      support('a', tilt, seasons, '2026-08-01T00:00:00.000Z'),
      support('b', tilt, seasons, '2026-08-01T00:00:00.000Z'),
    ]);
    const system = candidates.find((candidate) => candidate.key === semanticKey('system', 'earth'))!;
    const established: Place = {
      ...system,
      label: 'Earth',
      objectRevision: 1,
      originTransitionId: '20000000-0000-4000-8000-000000000001',
      activity: { availability: 'available', state: 'active' },
    };
    const proposal = requiredChanges({ ...f, objects: [established] });
    // The star is still due; the system only goes quiet.
    expect(kindsOf(proposal)).toEqual(['establish_star', 'set_activity']);
    expect(proposal.operations.at(-1)).toMatchObject({ objectId: system.id, state: 'quiet' });
  });
});

describe('reconciling a model proposal with what the rules require', () => {
  const full = facts([support('a'), support('b', hemispheres), support('c')]);
  const only = (...kinds: string[]): GeographyProposal => ({
    version: 'cartographer-proposal.v1',
    operations: requiredChanges(full).operations.filter((operation) => kinds.includes(operation.kind)),
  });

  it('adds the planet and regions a model left out, parents first', () => {
    const plan = reconcileWithRules(only('create_system', 'establish_star'), full);
    expect(plan.source).toBe('model_with_rules');
    expect(kindsOf(plan.proposal)).toEqual([
      'create_system',
      'establish_star',
      'form_planet',
      'add_region',
      'add_region',
    ]);
    expect(proposalIssue(plan.proposal, full)).toBeUndefined();
  });

  it('keeps a proposal that already covers the rules as the model proposed it', () => {
    const proposal = requiredChanges(full);
    expect(reconcileWithRules(proposal, full)).toEqual({ proposal, source: 'model' });
  });

  it('fills an empty proposal from the rules alone', () => {
    expect(reconcileWithRules({ version: 'cartographer-proposal.v1', operations: [] }, full)).toEqual({
      proposal: requiredChanges(full),
      source: 'rules',
    });
  });

  it('applies the rules alone when the model touches a place the rules also change', () => {
    const quietSupports = [
      support('a', tilt, seasons, '2026-08-01T00:00:00.000Z'),
      support('b', tilt, seasons, '2026-08-01T00:00:00.000Z'),
    ];
    const system = candidates.find((candidate) => candidate.key === semanticKey('system', 'earth'))!;
    const established: Place = {
      ...system,
      label: system.labels[0]!,
      objectRevision: 1,
      originTransitionId: '20000000-0000-4000-8000-000000000001',
      activity: { availability: 'available', state: 'active' },
    };
    const aged = facts(quietSupports, [established]);
    const relabel: GeographyProposal = {
      version: 'cartographer-proposal.v1',
      operations: [
        {
          kind: 'revise_label',
          objectId: system.id,
          label: system.labels[1]!,
          supportRefs: quietSupports.map((entry) => entry.ref),
        },
      ],
    };
    expect(proposalIssue(relabel, aged)).toBeUndefined();
    const plan = reconcileWithRules(relabel, aged);
    expect(plan.source).toBe('rules');
    expect(kindsOf(plan.proposal)).toEqual(['establish_star', 'set_activity']);
    expect(proposalIssue(plan.proposal, aged)).toBeUndefined();
  });

  it('applies the rules alone, capped at one delta, when the combination would not fit', () => {
    const everything = CONCEPTS.filter((topic) => topic.parent !== null).flatMap((topic) =>
      ['u1', 'u2', 'u3'].flatMap((unit) =>
        topic.facets.slice(0, 2).map((facetEntry) => support(`${topic.id}-${unit}`, facetEntry.id, topic.id)),
      ),
    );
    // The last region's whole chain is established, so the model's one operation is valid alone.
    const region = candidates
      .filter(
        (candidate) => candidate.kind === 'region' && everything.some((entry) => entry.facetId === candidate.conceptId),
      )
      .at(-1)!;
    const planet = candidates.find((candidate) => candidate.key === region.parentKey)!;
    const system = candidates.find((candidate) => candidate.key === planet.parentKey)!;
    const star = candidates.find((candidate) => candidate.kind === 'star' && candidate.conceptId === system.conceptId)!;
    const established: Place[] = [system, star, planet].map((candidate) => ({
      ...candidate,
      label: candidate.labels[0]!,
      objectRevision: 1,
      originTransitionId: '20000000-0000-4000-8000-000000000001',
      activity: { availability: 'available', state: 'active' },
    }));
    const rich = facts(everything, established);
    const model: GeographyProposal = {
      version: 'cartographer-proposal.v1',
      operations: [
        {
          kind: 'add_region',
          key: region.key,
          label: region.labels[0]!,
          truthStatus: 'factual',
          supportRefs: everything.filter((entry) => entry.facetId === region.conceptId).map((entry) => entry.ref),
        },
      ],
    };
    expect(proposalIssue(model, rich)).toBeUndefined();
    const plan = reconcileWithRules(model, rich);
    expect(plan.source).toBe('rules');
    expect(plan.proposal.operations).toHaveLength(MAX_PROPOSAL_OPERATIONS);
    expect(proposalIssue(plan.proposal, rich)).toBeUndefined();
  });
});

describe('reading only the newest keys of each facet (D-416)', () => {
  const planetTopics = CONCEPTS.filter((topic) => topic.parent !== null);
  const day = 86_400_000;
  const key = (entry: Support) => ({
    topicId: entry.topicId,
    facetId: entry.facetId,
    explanationUnitId: entry.explanationUnitId,
    lastActivatedAt: entry.activatedAt,
  });
  const bounded = (all: readonly Support[]) => {
    const kept = new Set(
      newestKeysPerFacet(all.map(key), EVALUATION.keysPerFacet).map(
        (entry) => `${entry.topicId}|${entry.facetId}|${entry.explanationUnitId}`,
      ),
    );
    return all.filter((entry) => kept.has(`${entry.topicId}|${entry.facetId}|${entry.explanationUnitId}`));
  };

  test.prop([
    fc.array(
      fc.record({
        unit: fc.constantFrom(...Array.from({ length: 12 }, (_, n) => `unit-${n}`)),
        topic: fc.constantFrom(...planetTopics),
        facet: fc.nat(2),
        ageDays: fc.nat(120),
      }),
      { maxLength: 400 },
    ),
  ])('changes no place the rules form and no activity they set', (picks) => {
    const all = [
      ...new Map(
        picks
          .map(({ unit, topic, facet, ageDays }) =>
            support(
              unit,
              topic.facets[facet % topic.facets.length]!.id,
              topic.id,
              new Date(Date.parse(NOW) - ageDays * day).toISOString(),
            ),
          )
          .map((entry) => [entry.ref, entry] as const),
      ).values(),
    ];
    const kept = bounded(all);
    expect(kept.length).toBeLessThanOrEqual(all.length);
    const before = facts(all),
      after = facts(kept);
    for (const candidate of candidates) {
      expect(formationEligible(after, candidate)).toBe(formationEligible(before, candidate));
      expect(activityFor(after, candidate)).toBe(activityFor(before, candidate));
    }
    expect(requiredChanges(after).operations.map((operation) => operation.kind)).toEqual(
      requiredChanges(before).operations.map((operation) => operation.kind),
    );
  });

  it('keeps the newest keys of each facet, newest first, a key with no time last, and a facet is never emptied', () => {
    const keys = [
      { topicId: seasons, facetId: tilt, explanationUnitId: 'old', lastActivatedAt: '2026-01-01T00:00:00.000Z' },
      { topicId: seasons, facetId: tilt, explanationUnitId: 'new', lastActivatedAt: '2026-10-02T00:00:00.000Z' },
      { topicId: seasons, facetId: tilt, explanationUnitId: 'newer', lastActivatedAt: '2026-10-03T00:00:00.000Z' },
      { topicId: seasons, facetId: tilt, explanationUnitId: 'untimed', lastActivatedAt: null },
      { topicId: seasons, facetId: hemispheres, explanationUnitId: 'only', lastActivatedAt: null },
    ];
    expect(newestKeysPerFacet(keys, 2).map((entry) => entry.explanationUnitId)).toEqual(['newer', 'new', 'only']);
    expect(newestKeysPerFacet(keys, 1).map((entry) => entry.explanationUnitId)).toEqual(['newer', 'only']);
    expect(newestKeysPerFacet(keys, 10)).toHaveLength(keys.length);
  });

  it('is deterministic whatever the input order', () => {
    const keys = planetTopics.flatMap((topic) =>
      topic.facets.flatMap((facetEntry, index) =>
        ['a', 'b', 'c', 'd', 'e'].map((unit) => ({
          topicId: topic.id,
          facetId: facetEntry.id,
          explanationUnitId: `${unit}-${index}`,
          lastActivatedAt: `2026-10-0${1 + (index % 3)}T00:00:00.000Z`,
        })),
      ),
    );
    const name = (list: readonly { topicId: string; facetId: string; explanationUnitId: string }[]) =>
      list.map((entry) => `${entry.topicId}|${entry.facetId}|${entry.explanationUnitId}`).sort();
    expect(name(newestKeysPerFacet([...keys].reverse(), 3))).toEqual(name(newestKeysPerFacet(keys, 3)));
  });
});

describe('the proof an operation cites (D-416)', () => {
  const day = 86_400_000;
  const facetsOfSeasons = CONCEPTS.find((topic) => topic.id === seasons)!.facets.map((facet) => facet.id);
  const crowd = (units: number) =>
    facetsOfSeasons.flatMap((facetId, n) =>
      Array.from({ length: units }, (_, unit) =>
        support(
          `u${String(n)}-${String(unit)}`,
          facetId,
          seasons,
          new Date(Date.parse(NOW) - (unit + n) * day).toISOString(),
        ),
      ),
    );

  it('cites every support of a place that has no more than the limit, in the order they were read', () => {
    const few = [support('a'), support('b', hemispheres), support('c')];
    const planet = requiredChanges(facts(few)).operations.find((operation) => operation.kind === 'form_planet')!;
    expect(planet.kind === 'form_planet' && planet.supportRefs).toEqual(few.map((entry) => entry.ref));
  });

  it('cuts a place with hundreds of supports to a proof the rules still accept, without losing a facet or its newest support', () => {
    const many = crowd(80);
    expect(many.length).toBeGreaterThan(300);
    const rules = requiredChanges(facts(many));
    const cited = (kind: string) =>
      rules.operations.filter((operation) => operation.kind === kind).map((operation) => operation.supportRefs);
    for (const refs of rules.operations.map((operation) => operation.supportRefs))
      expect(refs.length).toBeLessThanOrEqual(PROOF_REFS);
    expect(proposalIssue(rules, facts(many))).toBeUndefined();
    const [planetRefs] = cited('form_planet');
    const byRef = new Map(many.map((entry) => [entry.ref, entry]));
    // Every facet of the planet is among the references, each by its newest support.
    for (const facetId of facetsOfSeasons) {
      const newest = [...many]
        .filter((entry) => entry.facetId === facetId)
        .sort((a, b) => b.activatedAt.localeCompare(a.activatedAt))[0]!;
      expect(planetRefs).toContain(newest.ref);
    }
    expect(new Set(planetRefs!.map((ref) => byRef.get(ref)!.explanationUnitId)).size).toBeGreaterThanOrEqual(
      FORMATION.planetUnits,
    );
    // A system cites the newest of distinct units, at least the two it needs.
    const [systemRefs] = cited('create_system');
    expect(new Set(systemRefs!.map((ref) => byRef.get(ref)!.explanationUnitId)).size).toBeGreaterThanOrEqual(
      FORMATION.systemUnits,
    );
  });

  test.prop(
    [
      fc.array(
        fc.record({
          unit: fc.nat(60),
          topic: fc.constantFrom(...CONCEPTS.filter((topic) => topic.parent !== null)),
          facet: fc.nat(3),
          ageDays: fc.nat(100),
        }),
        { minLength: 1, maxLength: 600 },
      ),
    ],
    { numRuns: 60 },
  )('every operation the rules require cites a proof the rules accept, within the limit', (picks) => {
    const all = [
      ...new Map(
        picks
          .map(({ unit, topic, facet, ageDays }) =>
            support(
              `u-${String(unit)}`,
              topic.facets[facet % topic.facets.length]!.id,
              topic.id,
              new Date(Date.parse(NOW) - ageDays * day).toISOString(),
            ),
          )
          .map((entry) => [entry.ref, entry] as const),
      ).values(),
    ];
    const f = facts(all);
    const rules = requiredChanges(f);
    for (const operation of rules.operations) expect(operation.supportRefs.length).toBeLessThanOrEqual(PROOF_REFS);
    expect(proposalIssue(rules, f)).toBeUndefined();
  });
});
