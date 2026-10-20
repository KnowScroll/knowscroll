import { describe, expect, it } from 'vitest';
import {
  CONTEXT_POLICY,
  ContributionSchema,
  ContextQuerySchema,
  supportChanges,
  supports,
  type Contribution,
} from './context.js';
const contribution = (patch: Partial<Contribution> = {}): Contribution => ({
  version: 'personal-contribution.v0',
  exposureId: '10000000-0000-4000-8000-000000000001',
  assetId: '20000000-0000-4000-8000-000000000001',
  assetRevision: 1,
  activatedAt: '2026-10-20T00:00:00.000Z',
  explanationUnitId: 'fixture-mechanism',
  qualified: true,
  coveredFacets: [],
  topics: [{ topicId: 'fixture-topic', role: 'primary' }],
  input: {
    qualificationRevision: 1,
    actionRevision: 0,
    navigationRevision: 0,
    attribution: 'fixture',
    activityPolicy: 'activity.v0',
    projectionPolicy: CONTEXT_POLICY,
  },
  ...patch,
});
describe('personal structural support (labelled source fixtures)', () => {
  it('does not derive variety from likes, incidental tags or unqualified encounters', () => {
    expect(supports(contribution({ qualified: false }))).toEqual([]);
    expect(supports(contribution({ topics: [{ topicId: 'incidental', role: 'incidental' }] }))).toEqual([]);
    expect(supports(contribution())).toEqual([{ topicId: 'fixture-topic', kind: 'unit', key: 'fixture-mechanism' }]);
  });
  it('variant identities and replay leave support keys unchanged; A to B to A is reversible', () => {
    const a = contribution(),
      b = contribution({ explanationUnitId: 'fixture-example', topics: [{ topicId: 'other', role: 'supporting' }] });
    expect(supportChanges(a, { ...a, assetId: '20000000-0000-4000-8000-000000000002' })).toEqual([]);
    const forward = supportChanges(a, b),
      backward = supportChanges(b, a);
    expect(forward).toHaveLength(2);
    for (const change of forward) expect(backward).toContainEqual({ ...change, delta: -change.delta });
  });
  it('refuses unqualified facet assertions and duplicate/oversized requested context', () => {
    expect(ContributionSchema.safeParse(contribution({ qualified: false, coveredFacets: ['example'] })).success).toBe(
      false,
    );
    expect(
      ContextQuerySchema.safeParse({ evaluatedAt: '2026-10-20T00:00:00.000Z', topicIds: ['a', 'a'], candidates: [] })
        .success,
    ).toBe(false);
    expect(
      ContextQuerySchema.safeParse({
        evaluatedAt: '2026-10-20T00:00:00.000Z',
        topicIds: [],
        candidates: [],
        provisionalLimit: 21,
      }).success,
    ).toBe(false);
  });
});
