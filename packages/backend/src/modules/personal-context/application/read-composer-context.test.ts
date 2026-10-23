import { describe, expect, it, vi } from 'vitest';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { ExplorationSnapshot } from './ports.js';
import { makeReadComposerContext } from './read-composer-context.js';
const id = '10000000-0000-4000-8000-000000000001';
const scope = {
  authority: { universeId: id, privacyEpoch: 1, actor: { kind: 'system', purpose: 'ci.fixture' } },
  revisionAtEntry: 12,
} as PersonalScopeTx;
const query = {
  evaluatedAt: '2026-10-20T00:00:00.000Z',
  topicIds: ['positive', 'zero', 'missing'],
  candidates: [{ explanationUnitId: 'fixture-unit', facets: ['facet'] }],
  candidateAssetIds: [id],
};
function snapshot(): ExplorationSnapshot {
  return {
    version: 'exploration-snapshot.v0',
    proofAvailability: 'available',
    proofReason: 'bounded',
    universeId: id,
    privacyEpoch: 1,
    evaluatedAt: query.evaluatedAt,
    policyVersion: 'personal-context.v0',
    revision: 4,
    watermarks: { scope: 12, projected: 10 },
    completeness: 'not_asserted',
    coverageAvailability: 'unavailable',
    topics: ['positive', 'zero', 'missing'].map((topicId) => ({
      topicId,
      statisticsAvailability: topicId === 'missing' ? 'not_observed' : 'available',
      activity: topicId === 'positive' ? 2 : 0,
      interest: topicId === 'positive' ? 2 / 3 : 0,
      channels: { q: 1, L: 0, B: 0, S: 0, H: 0, R: 0 },
      formats: [{ kind: 'scroll', measured: 1, qualified: 1, fit: 2 / 3 }],
      qualifiedExplanationUnits: 99,
      coveredFacets: 0,
    })),
    qualified: [],
    supportingEvidence: [],
    routing: {
      recent: [
        { exposureId: id, activatedAt: query.evaluatedAt, explanationUnitId: 'fixture-unit', facets: ['facet'] },
      ],
      established: [
        { explanationUnitId: 'fixture-unit', encountered: true, facets: [{ facetId: 'facet', encountered: true }] },
      ],
      hiddenAssetIds: [id],
    },
    provisional: {
      purpose: 'routing_only',
      entries: [{ eventId: id, exposureId: id, inputWatermark: '999' }],
      hasMore: false,
    },
  };
}
describe('PC to Composer compatibility read (labelled fixtures)', () => {
  it('keeps observed zero, omits absent history, preserves Q/O and routing, and excludes provisional/structural arithmetic', async () => {
    const s = snapshot(),
      read = vi.fn(() => Promise.resolve(s));
    const output = await makeReadComposerContext(read)(scope, query);
    expect(read).toHaveBeenCalledWith(scope, { ...query, provisionalLimit: 0 });
    expect(output).toMatchObject({
      policyVersion: 'personal-context.v0',
      watermark: 'personal-context-composer.v0:4:12:10:not_asserted',
    });
    expect(output?.topics).toEqual([
      { topicId: 'positive', activity: 2, formats: [{ kind: 'scroll', measured: 1, qualified: 1 }] },
      { topicId: 'zero', activity: 0, formats: [{ kind: 'scroll', measured: 1, qualified: 1 }] },
    ]);
    expect(output).not.toHaveProperty('provisional');
    expect(output).not.toHaveProperty('qualified');
    expect(output?.topics[0]).not.toHaveProperty('interest');
    expect(output?.topics[0]).not.toHaveProperty('qualifiedExplanationUnits');
    expect(output?.established?.watermark).toBe(output?.watermark);
    expect(output?.recent).toEqual(s.routing.recent);
    expect(output?.hiddenAssetIds).toEqual([id]);
    (s.routing.recent[0]!.facets as string[]).push('late-mutation');
    expect(output?.recent[0]?.facets).toEqual(['facet']);
  });
  it('carries the current plan beside the context and names it in the watermark; no plan changes nothing', async () => {
    const plan = {
      revision: 6,
      opportunities: [
        {
          move: 'limitation' as const,
          topicIds: ['positive'],
          explanationUnitId: 'fixture-unit',
          eligibility: ['vertical' as const],
          formats: ['scroll' as const],
          expiresAt: '2026-10-21T00:00:00.000Z',
          target: 'existing' as const,
        },
      ],
    };
    const readPlan = vi.fn(() => Promise.resolve(plan));
    const planned = await makeReadComposerContext(() => Promise.resolve(snapshot()), readPlan)(scope, query);
    expect(readPlan).toHaveBeenCalledWith(scope, { evaluatedAt: query.evaluatedAt });
    expect(planned?.plan).toEqual(plan);
    expect(planned?.watermark).toBe('personal-context-composer.v0:4:12:10:not_asserted:plan-6');
    expect(planned?.established?.watermark).toBe(planned?.watermark);
    const none = await makeReadComposerContext(
      () => Promise.resolve(snapshot()),
      () => Promise.resolve(undefined),
    )(scope, query);
    expect(none).not.toHaveProperty('plan');
    expect(none?.watermark).toBe('personal-context-composer.v0:4:12:10:not_asserted');
  });
  it.each(['universe', 'epoch', 'time', 'scope', 'futureProjection'] as const)(
    'refuses mismatched %s rather than falling back to Evidence',
    async (kind) => {
      const s = snapshot();
      const invalid =
        kind === 'universe'
          ? { ...s, universeId: 'other' }
          : kind === 'epoch'
            ? { ...s, privacyEpoch: 2 }
            : kind === 'time'
              ? { ...s, evaluatedAt: '2026-10-21T00:00:00.000Z' }
              : { ...s, watermarks: { ...s.watermarks, [kind === 'scope' ? 'scope' : 'projected']: 13 } };
      await expect(makeReadComposerContext(() => Promise.resolve(invalid))(scope, query)).rejects.toThrow(
        'PERSONAL_CONTEXT_COMPOSER_INPUT_INVALID',
      );
    },
  );
  it.each(['topics', 'units', 'facets', 'assets'] as const)('rejects oversized %s before reading', async (kind) => {
    const read = vi.fn(() => Promise.resolve(snapshot()));
    const invalid =
      kind === 'topics'
        ? { ...query, topicIds: Array.from({ length: 101 }, (_, i) => String(i)) }
        : kind === 'units'
          ? {
              ...query,
              candidates: Array.from({ length: 101 }, (_, i) => ({ explanationUnitId: String(i), facets: [] })),
            }
          : kind === 'facets'
            ? {
                ...query,
                candidates: [
                  { explanationUnitId: 'fixture-unit', facets: Array.from({ length: 17 }, (_, i) => String(i)) },
                ],
              }
            : { ...query, candidateAssetIds: Array.from({ length: 101 }, () => id) };
    await expect(makeReadComposerContext(read)(scope, invalid)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});
