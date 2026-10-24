import { fc, test } from '@fast-check/vitest';
import { describe, it, expect } from 'vitest';
import {
  formationEligible,
  proposalIssue,
  proposalFault,
  activityFor,
  semanticKey,
  GeographyProposalSchema,
  type FormationFacts,
  type Support,
  type Candidate,
} from './policy.js';
const topic = 'earth.seasons',
  other = 'earth.tides';
const catalogue = [
  { id: 'earth', parent: null, facets: [] },
  { id: topic, parent: 'earth', facets: [`${topic}.axial-tilt`, `${topic}.hemispheres`] },
  { id: other, parent: 'earth', facets: [`${other}.forcing`] },
];
const candidate = (kind: Candidate['kind'], id: string, parentKey = 'universe'): Candidate => ({
  key: semanticKey(kind, id),
  id: `10000000-0000-4000-8000-${kind === 'planet' ? '000000000003' : kind === 'star' ? '000000000002' : '000000000001'}`,
  kind,
  conceptId: id,
  parentKey,
  truthStatus: 'factual',
  labels: ['Authored fixture'],
});
const system = candidate('system', 'earth'),
  star = candidate('star', 'earth', system.key),
  planet = candidate('planet', topic, system.key);
const support = (unit: string, facet = `${topic}.axial-tilt`, t = topic): Support => ({
  ref: `${t}:${unit}:${facet}`,
  topicId: t,
  facetId: facet,
  explanationUnitId: unit,
  truthStatus: 'factual',
  activatedAt: '2026-10-01T00:00:00.000Z',
});
const facts = (supports: Support[]): FormationFacts => ({
  catalogue,
  supports,
  candidates: [system, star, planet],
  objects: [],
  routes: [],
  evaluatedAt: '2026-10-20T00:00:00.000Z',
  completeness: 'not_asserted',
});
describe('experimental Geography formation (authored positive-support fixtures only)', () => {
  it('unviewed inventory, scores and tags cannot supply a single support', () => {
    const f = facts([]);
    expect(formationEligible(f, system)).toBe(false);
    expect(formationEligible(f, planet)).toBe(false);
  });
  it('forms a coherent system/star at two units, and a same-subtopic planet only at three units and two facets', () => {
    const two = facts([support('one'), support('two')]);
    expect(formationEligible(two, system)).toBe(true);
    expect(formationEligible(two, star)).toBe(true);
    expect(formationEligible(two, planet)).toBe(false);
    const three = facts([support('one'), support('two'), support('three')]);
    expect(formationEligible(three, planet)).toBe(false);
    const varied = facts([support('one'), support('two', `${topic}.hemispheres`), support('three')]);
    expect(formationEligible(varied, planet)).toBe(true);
    const unrelated = facts([
      support('one'),
      support('two', `${other}.forcing`, other),
      support('three', 'earth.greenhouse-effect.balance', 'earth.greenhouse-effect'),
    ]);
    expect(formationEligible(unrelated, planet)).toBe(false);
  });
  it('names the first operation that breaks a proposal, so a repair can point at it', () => {
    const f = facts([support('one'), support('two'), support('three')]);
    const operation = (
      kind: 'create_system' | 'establish_star',
      c: Candidate,
      refs = f.supports.map((s) => s.ref),
    ) => ({
      kind,
      key: c.key,
      label: c.labels[0]!,
      truthStatus: 'factual' as const,
      supportRefs: refs,
    });
    const proposal = (operations: ReturnType<typeof operation>[]) => ({
      version: 'cartographer-proposal.v1' as const,
      operations,
    });
    expect(proposalFault(proposal([operation('create_system', system), operation('establish_star', star)]), f)).toBe(
      undefined,
    );
    expect(
      proposalFault(
        proposal([operation('create_system', system), operation('establish_star', star, [f.supports[0]!.ref])]),
        f,
      ),
    ).toEqual({ code: 'formation_support', operation: 1 });
    expect(proposalFault(proposal([operation('establish_star', star, ['invented'])]), f)).toEqual({
      code: 'support_authority',
      operation: 0,
    });
  });
  it('requires complete ordered hierarchy and refuses hypothetical laundering or invented support refs', () => {
    const f = facts([support('one'), support('two', `${topic}.hemispheres`), support('three')]);
    const operation = (kind: 'create_system' | 'establish_star' | 'form_planet', c: Candidate) => ({
      kind,
      key: c.key,
      label: c.labels[0]!,
      truthStatus: 'factual' as const,
      supportRefs: f.supports.map((s) => s.ref),
    });
    expect(
      proposalIssue({ version: 'cartographer-proposal.v1', operations: [operation('form_planet', planet)] }, f),
    ).toBe('hierarchy');
    const p = {
      version: 'cartographer-proposal.v1' as const,
      operations: [
        operation('create_system', system),
        operation('establish_star', star),
        operation('form_planet', planet),
      ],
    };
    expect(proposalIssue(p, f)).toBeUndefined();
    expect(
      proposalIssue({ ...p, operations: [{ ...operation('create_system', system), truthStatus: 'hypothetical' }] }, f),
    ).toBe('unsupported_truth');
    expect(
      proposalIssue(
        { ...p, operations: [{ ...operation('create_system', system), supportRefs: ['another-person-private-id'] }] },
        f,
      ),
    ).toBe('support_authority');
    expect(
      GeographyProposalSchema.safeParse({
        version: 'cartographer-proposal.v1',
        operations: [{ kind: 'merge', from: 'a', to: 'b' }],
      }).success,
    ).toBe(false);
  });
  it('age changes only the coarse activity policy, never formation eligibility or stable identity', () => {
    const f = facts([support('one'), support('two', `${topic}.hemispheres`), support('three')]);
    expect(activityFor(f, planet)).toBe('active');
    const old = { ...f, evaluatedAt: '2027-01-01T00:00:00.000Z' };
    expect(activityFor(old, planet)).toBe('quiet');
    expect(formationEligible(old, planet)).toBe(true);
    expect(old.candidates[2]!.key).toBe(planet.key);
  });
  test.prop([fc.integer({ min: 1, max: 500 }), fc.boolean()])(
    'repeating one canonical explanation across arbitrary witnesses/facets never forms a system or planet',
    (copies, vary) => {
      const supports = Array.from({ length: copies }, (_, i) =>
        support('one-unit', vary && i % 2 ? `${topic}.hemispheres` : `${topic}.axial-tilt`),
      );
      expect(formationEligible(facts(supports), system)).toBe(false);
      expect(formationEligible(facts(supports), planet)).toBe(false);
    },
  );
  test.prop([fc.array(fc.integer({ min: 0, max: 2 }), { maxLength: 100 })])(
    'deduplication and ordering do not change distinct qualified-unit thresholds',
    (indexes) => {
      const supports = indexes.map((i, n) =>
        support(`unit-${i}`, n % 2 ? `${topic}.hemispheres` : `${topic}.axial-tilt`),
      );
      const f = facts(supports),
        reversed = facts([...supports].reverse());
      expect(formationEligible(f, planet)).toBe(formationEligible(reversed, planet));
      expect(formationEligible(f, planet)).toBe(
        new Set(supports.map((s) => s.explanationUnitId)).size >= 3 &&
          new Set(supports.map((s) => s.facetId)).size >= 2,
      );
    },
  );
});
