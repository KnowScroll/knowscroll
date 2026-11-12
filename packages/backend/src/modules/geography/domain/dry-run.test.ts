import { describe, expect, it } from 'vitest';
import { planSnapshot } from '../../content/public.js';
import { shapeGeographyDryRun, type GeographyDryRunFacts, type GeographyPreparedFacts } from './dry-run.js';
import { semanticKey, type Candidate, type FormationFacts, type Place, type Support } from './policy.js';

/** The catalogue of the library plan (release 1): the fixture these rules are exercised on. */
const CONCEPTS = planSnapshot().all();

/** Authored supports over the real concept catalogue, with labels and ids a leak would show; none of this is a person's reading. */
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
    labels: [`CI-PRIVATE-LABEL ${conceptId}`],
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
const NOW = '2026-10-20T00:00:00.000Z';
const support = (unit: string, facetId = tilt, activatedAt = '2026-10-19T00:00:00.000Z'): Support => ({
  ref: `CI-PRIVATE-REF:${unit}:${facetId}`,
  topicId: seasons,
  facetId,
  explanationUnitId: `CI-PRIVATE-UNIT-${unit}`,
  truthStatus: 'factual',
  activatedAt,
});
const formation = (supports: Support[], objects: Place[] = []): FormationFacts => ({
  catalogue,
  supports,
  candidates,
  objects,
  routes: [],
  evaluatedAt: NOW,
  completeness: 'not_asserted',
});
const prepared = (
  formationFacts: FormationFacts,
  over: Partial<GeographyPreparedFacts> = {},
): GeographyPreparedFacts => ({
  formation: formationFacts,
  topicsEvaluated: 1,
  candidateKeys: 3,
  witnessesHeld: 3,
  supportKeys: formationFacts.supports.length,
  nothingTrusted: false,
  contextBytes: 4096,
  modelItems: 9,
  ...over,
});
const facts = (over: Partial<GeographyDryRunFacts> = {}): GeographyDryRunFacts => ({
  gate: 'open',
  roleEnabled: true,
  places: 0,
  routes: 0,
  refusal: undefined,
  prepared: prepared(formation([support('a'), support('b', hemispheres), support('c')])),
  failureCode: undefined,
  ...over,
});
const placeFor = (candidate: Candidate, activity: Place['activity']): Place => ({
  ...candidate,
  label: candidate.labels[0]!,
  objectRevision: 1,
  originTransitionId: 'earlier',
  activity,
});

describe('the Cartographer dry run report (D-411)', () => {
  it('counts what is due by kind, and what one delta would apply', () => {
    const report = shapeGeographyDryRun(facts());
    expect(report).toMatchObject({
      trigger: 'reading',
      action: 'calls_model',
      wouldCallModel: true,
      wouldRecord: { status: 'accepted', outcome: null },
      due: { system: 1, star: 1, planet: 1, region: 2, total: 5, appliedByNextRun: 5 },
      activityChanges: { toQuiet: 0, toActive: 0 },
      references: { topicsEvaluated: 1, candidateKeys: 3, witnessesHeld: 3, supportKeys: 3 },
      contextBytes: 4096,
      modelItems: 9,
    });
  });

  it('follows the order a real run decides in: gate, switch, fault, refusal, due places, activity, nothing', () => {
    expect(shapeGeographyDryRun(facts({ gate: 'not_runnable' }))).toMatchObject({
      action: 'not_runnable',
      wouldRecord: null,
    });
    expect(shapeGeographyDryRun(facts({ gate: 'recording_paused' }))).toMatchObject({
      action: 'recording_paused',
      wouldRecord: null,
    });
    // The role off wins over everything below it, as the run releases `disabled` before it freezes a context.
    expect(shapeGeographyDryRun(facts({ roleEnabled: false }))).toMatchObject({
      action: 'stops',
      wouldRecord: { status: 'insufficient', outcome: 'disabled' },
      wouldCallModel: false,
    });
    expect(shapeGeographyDryRun(facts({ failureCode: 'GEOGRAPHY_WITNESS_AUTHORITY' }))).toMatchObject({
      action: 'would_fail',
      failureCode: 'GEOGRAPHY_WITNESS_AUTHORITY',
    });
    expect(
      shapeGeographyDryRun(facts({ refusal: 'no_support_yet', prepared: undefined, places: 2, routes: 1 })),
    ).toMatchObject({
      action: 'stops',
      wouldRecord: { status: 'insufficient', outcome: 'no_support_yet' },
      places: 2,
      routes: 1,
    });
    expect(shapeGeographyDryRun(facts({ prepared: prepared(formation([support('a')])) }))).toMatchObject({
      action: 'stops',
      wouldRecord: { status: 'insufficient', outcome: 'no_changes' },
      wouldCallModel: false,
    });
  });

  it('applies the rules alone, with no model call, when the context does not fit one request, under the code a run records', () => {
    expect(
      shapeGeographyDryRun(facts({ prepared: prepared(facts().prepared!.formation, { modelItems: 'too_large' }) })),
    ).toMatchObject({
      action: 'applies_rules',
      wouldRecord: { status: 'accepted', outcome: 'applied_by_rules_context_limit' },
      wouldCallModel: false,
      modelItems: null,
      due: { total: 5 },
    });
  });

  it('applies activity alone by the rules, with no model call, and counts the direction of each change', () => {
    const base = [support('a'), support('b', hemispheres)];
    const established = candidates
      .filter(
        (candidate) =>
          candidate.conceptId === seasons.split('.')[0] && (candidate.kind === 'system' || candidate.kind === 'star'),
      )
      .map((candidate) => placeFor(candidate, { availability: 'available', state: 'quiet' }));
    // Support activated yesterday under places stored quiet: they are due to become active.
    const report = shapeGeographyDryRun(facts({ prepared: prepared(formation(base, established)) }));
    expect(report).toMatchObject({
      action: 'applies_rules',
      wouldRecord: { status: 'accepted', outcome: 'applied_by_rules' },
      wouldCallModel: false,
      due: { total: 0, appliedByNextRun: 2 },
      activityChanges: { toQuiet: 0, toActive: 2 },
    });
  });

  it('caps what one delta applies at 32 operations', () => {
    // Every planet of the catalogue read three times over every facet: far more is due than one delta holds.
    const everything: Support[] = CONCEPTS.filter((topic) => topic.parent !== null).flatMap((topic) =>
      topic.facets.flatMap((facet) =>
        ['a', 'b', 'c'].map((unit) => ({
          ...support(`${topic.id}-${unit}`, facet.id),
          topicId: topic.id,
          ref: `CI-PRIVATE-REF:${topic.id}:${facet.id}:${unit}`,
        })),
      ),
    );
    const report = shapeGeographyDryRun(facts({ prepared: prepared(formation(everything)) }));
    expect(report.due.total).toBeGreaterThan(32);
    expect(report.due.appliedByNextRun).toBe(32);
  });

  it('names a reader whose probed keys are all untrusted as a run records it, unless activity is due', () => {
    const none = formation([]);
    expect(
      shapeGeographyDryRun(facts({ prepared: prepared(none, { supportKeys: 0, nothingTrusted: true }) })),
    ).toMatchObject({ action: 'stops', wouldRecord: { status: 'insufficient', outcome: 'no_trusted_support' } });
    expect(shapeGeographyDryRun(facts({ prepared: prepared(none, { supportKeys: 0 }) }))).toMatchObject({
      wouldRecord: { status: 'insufficient', outcome: 'no_changes' },
    });
  });

  it('reports what the evaluation read, and nulls for what was not reached', () => {
    const kept = formation([support('a'), support('b')]);
    expect(
      shapeGeographyDryRun(facts({ prepared: prepared(kept, { supportKeys: 2, topicsEvaluated: 3 }) })).references,
    ).toMatchObject({ topicsEvaluated: 3, supportKeys: 2 });
    expect(
      shapeGeographyDryRun(facts({ refusal: 'structure_limit', prepared: undefined, places: 1001, routes: 0 })),
    ).toMatchObject({
      wouldRecord: { status: 'insufficient', outcome: 'structure_limit' },
      places: 1001,
      references: { topicsEvaluated: null, candidateKeys: null, witnessesHeld: null, supportKeys: null },
      contextBytes: null,
    });
  });

  it('prints counts and codes only: no label, unit, reference, topic or id', () => {
    const report = shapeGeographyDryRun(facts());
    const text = JSON.stringify(report);
    for (const word of ['CI-PRIVATE', 'earth', 'seasons', 'axial', '10000000-0000', 'support:', 'system:earth'])
      expect(text).not.toContain(word);
    const leaves = (value: unknown): unknown[] =>
      value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value];
    for (const leaf of leaves(report)) {
      if (typeof leaf === 'string') expect(leaf).toMatch(/^[a-z_]+$/);
      else expect(['number', 'boolean'].includes(typeof leaf) || leaf === null).toBe(true);
    }
  });
});
