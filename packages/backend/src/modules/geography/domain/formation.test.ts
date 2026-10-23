import { fc, test } from '@fast-check/vitest';
import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { completeProposal, requiredChanges } from './formation.js';
import {
  MAX_PROPOSAL_OPERATIONS,
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
    labels: [conceptId],
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

describe('completing a model proposal with what the rules require', () => {
  const full = facts([support('a'), support('b', hemispheres), support('c')]);
  const only = (...kinds: string[]): GeographyProposal => ({
    version: 'cartographer-proposal.v1',
    operations: requiredChanges(full).operations.filter((operation) => kinds.includes(operation.kind)),
  });

  it('adds the planet and regions a model left out, parents first', () => {
    const completed = completeProposal(only('create_system', 'establish_star'), full);
    expect(kindsOf(completed)).toEqual(['create_system', 'establish_star', 'form_planet', 'add_region', 'add_region']);
    expect(proposalIssue(completed, full)).toBeUndefined();
  });

  it('returns a proposal that already covers the rules unchanged', () => {
    const proposal = requiredChanges(full);
    expect(completeProposal(proposal, full)).toBe(proposal);
  });

  it('fills an empty proposal from the rules alone', () => {
    expect(completeProposal({ version: 'cartographer-proposal.v1', operations: [] }, full)).toEqual(
      requiredChanges(full),
    );
  });
});
