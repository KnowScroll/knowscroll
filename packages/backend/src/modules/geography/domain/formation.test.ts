import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { compactSupports } from './compaction.js';
import { reconcileWithRules, requiredChanges } from './formation.js';
import {
  FORMATION,
  MAX_PROPOSAL_OPERATIONS,
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

describe('compacting supports for one frozen context', () => {
  const planetTopics = CONCEPTS.filter((topic) => topic.parent !== null);
  // Per planet the rules need its newest support per facet plus enough further units.
  const keepsEverythingTheRulesRead = planetTopics.reduce(
    (sum, topic) => sum + topic.facets.length + FORMATION.planetUnits,
    0,
  );
  const day = 86_400_000;

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
    const byRef = new Map(
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
    );
    const all = [...byRef.values()];
    const kept = compactSupports(
      all.map((entry) => ({ support: entry, bytes: 1_000 })),
      { count: keepsEverythingTheRulesRead, bytes: Number.MAX_SAFE_INTEGER },
    ).map((entry) => entry.support);
    expect(kept.length).toBeLessThanOrEqual(keepsEverythingTheRulesRead);
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

  it('keeps the newest support of each facet first, then further units, within the count and bytes', () => {
    const entries = [
      support('old-1', tilt, seasons, '2026-01-01T00:00:00.000Z'),
      support('new-1', tilt, seasons, '2026-10-01T00:00:00.000Z'),
      support('new-2', tilt, seasons, '2026-10-02T00:00:00.000Z'),
      support('only-limits', limits, seasons, '2026-03-01T00:00:00.000Z'),
      support('third-unit', hemispheres, seasons, '2026-02-01T00:00:00.000Z'),
    ].map((entry) => ({ support: entry, bytes: 100 }));
    const refs = (list: readonly { support: { ref: string } }[]) => list.map((entry) => entry.support.ref);
    // Facet tier: the newest per facet (new-2, only-limits, third-unit). Unit tier then needs no more.
    expect(refs(compactSupports(entries, { count: 3, bytes: 10_000 }))).toEqual(
      refs([entries[2]!, entries[3]!, entries[4]!]),
    );
    // A byte budget for two keeps the two newest facets.
    expect(refs(compactSupports(entries, { count: 10, bytes: 200 }))).toEqual(refs([entries[2]!, entries[3]!]));
    // Within budget nothing changes, and order is the input's.
    expect(compactSupports(entries, { count: 10, bytes: 10_000 })).toBe(entries);
  });

  it('is deterministic whatever the input order', () => {
    const entries = planetTopics
      .flatMap((topic) =>
        topic.facets.flatMap((facetEntry, index) =>
          ['a', 'b', 'c'].map((unit) =>
            support(`${unit}-${index}`, facetEntry.id, topic.id, `2026-10-0${1 + index}T00:00:00.000Z`),
          ),
        ),
      )
      .map((entry) => ({ support: entry, bytes: 400 }));
    const budget = { count: 100, bytes: 360_000 };
    const refs = (list: readonly { support: { ref: string } }[]) => list.map((entry) => entry.support.ref).sort();
    const forward = compactSupports(entries, budget);
    expect(forward.length).toBeLessThanOrEqual(100);
    expect(refs(compactSupports([...entries].reverse(), budget))).toEqual(refs(forward));
  });
});
