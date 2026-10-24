import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../../content/public.js';
import { requiredChanges } from '../domain/formation.js';
import {
  semanticKey,
  type Candidate,
  type FormationFacts,
  type GeographyProposal,
  type Support,
} from '../domain/policy.js';
import type { GeographyContext } from './ports.js';
import { cartographerRole, cartographyContextItems } from './role.js';

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

const support = (topicId: string, facetId: string, unit: string): Support => ({
  ref: `support:${topicId}:${facetId}:${unit}`.padEnd(72, 'x'),
  topicId,
  facetId,
  explanationUnitId: unit,
  truthStatus: 'factual',
  activatedAt: '2026-10-19T00:00:00.000Z',
});

function contextOf(supports: Support[]): GeographyContext {
  const facts: FormationFacts = {
    catalogue,
    supports,
    candidates,
    objects: [],
    routes: [],
    evaluatedAt: '2026-10-20T00:00:00.000Z',
    completeness: 'not_asserted',
  };
  // Only the fields the role reads; the rest of a frozen context is the store's business.
  return {
    version: 'cartographer-context.v1',
    pcRevision: 1,
    base: { revision: 0 },
    facts,
  } as unknown as GeographyContext;
}

/** `perFacet` distinct units on each of the first two facets of one planet in each of the first `systems` systems. */
function heavyReader(systems: number, perFacet: number): Support[] {
  const planets = CONCEPTS.filter((topic) => topic.parent !== null);
  const roots = [...new Set(planets.map((topic) => topic.parent!))].slice(0, systems);
  return roots.flatMap((root) => {
    const planet = planets.find((topic) => topic.parent === root)!;
    return planet.facets
      .slice(0, 2)
      .flatMap((facet, facetIndex) =>
        Array.from({ length: perFacet }, (_, n) => support(planet.id, facet.id, `${planet.id}:${facetIndex}:${n}`)),
      );
  });
}

const dueItems = (context: GeographyContext) => cartographyContextItems(context).filter((item) => item.kind === 'due');

describe('what the Cartographer is asked', () => {
  const planet = CONCEPTS.find((topic) => topic.parent !== null)!;
  const twoUnits = contextOf([
    support(planet.id, planet.facets[0]!.id, 'unit-a'),
    support(planet.id, planet.facets[1]!.id, 'unit-b'),
  ]);

  it('names the version it must return, because a model that is not told leaves it out', () => {
    const { instructions, version } = cartographerRole(twoUnits);
    expect(instructions).toContain('{"version":"cartographer-proposal.v1","operations":[');
    expect(instructions).toContain('"version" is required and must be exactly cartographer-proposal.v1');
    expect(version).toBe('cartographer2');
  });

  it('asks the model only for what it adds, because code applies every due operation anyway', () => {
    const { instructions } = cartographerRole(twoUnits);
    expect(instructions).toContain('Code applies all of them whatever you return, so do not repeat them');
    expect(instructions).toContain('an empty operations array is a good answer');
    expect(instructions).not.toContain('Return every due operation');
  });

  it('hands over what the rules already entitle as ready operations, and nothing when nothing is due', () => {
    const due = dueItems(twoUnits).flatMap((item) => JSON.parse(item.text) as unknown[]);
    expect(due).toEqual(JSON.parse(JSON.stringify(requiredChanges(twoUnits.facts).operations)));
    expect(due.length).toBeGreaterThan(0);
    expect(dueItems(contextOf([support(planet.id, planet.facets[0]!.id, 'unit-a')]))).toEqual([]);
  });

  it('keeps every due item inside the context item size, however many places a heavy reader is owed', () => {
    const context = contextOf(heavyReader(4, 12));
    const items = dueItems(context);
    expect(items.length).toBeGreaterThan(1);
    for (const item of items) expect(item.text.length).toBeLessThanOrEqual(32768);
    expect(items.flatMap((item) => JSON.parse(item.text) as unknown[])).toHaveLength(
      requiredChanges(context.facts).operations.length,
    );
  });

  it('answers a broken proposal with the operation that broke it and a hint written for that rule', () => {
    const role = cartographerRole(twoUnits);
    const [system, star] = requiredChanges(twoUnits.facts).operations;
    const proposal = {
      version: 'cartographer-proposal.v1',
      operations: [system, { ...star!, supportRefs: [(star as { supportRefs: string[] }).supportRefs[0]!] }],
    } as GeographyProposal;
    const result = role.outputSchema.safeParse(proposal);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toHaveLength(1);
    const [issue] = result.error.issues;
    expect(issue?.path).toEqual(['operations', 1]);
    expect(issue?.code).toBe('custom');
    const code = (issue as { params?: { safeCode?: string } }).params?.safeCode;
    expect(code).toBe('formation_support');
    expect(role.safeCustomIssues?.[code!]).toContain('two distinct units');
  });

  it('gives every rule its own short plain hint', () => {
    const hints = Object.values(cartographerRole(twoUnits).safeCustomIssues ?? {});
    expect(new Set(hints).size).toBe(hints.length);
    for (const hint of hints) {
      expect(hint.length).toBeLessThanOrEqual(256);
      expect(hint).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
  });
});
