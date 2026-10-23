import { describe, expect, it } from 'vitest';
import type { ProposeInput, ProposeOutcome, ReasoningHarness } from '../../../reasoning/public.js';
import type { EncounterSnapshot } from '../../content/public.js';
import { JEV_SHORTLIST_LIMIT, semanticFitOf } from '../domain/jev.js';
import { JEV_ROLE, acceptAssessments, jevContext, makeAssessShortlist, storedAssessments } from './jev.js';

function encounter(index: number): EncounterSnapshot {
  return {
    assetId: `asset-${String(index)}`,
    assetRevision: 1,
    kind: 'scroll',
    explanationUnitId: `unit-${String(index)}`,
    metadata: { kind: 'scroll', title: `Title ${String(index)}`, summary: `Summary ${String(index)}`, language: 'en' },
    topics: [],
    facets: [`facet-${String(index)}`],
    siblings: [],
    catalogWatermark: 'watermark',
    attributionVersion: 'taxonomy',
  };
}

describe('Jev (labelled CI fixtures; no provider output)', () => {
  it('combines criteria by fixed weights into a bounded SemanticFit', () => {
    expect(semanticFitOf({ relevance: 1, appropriateness: 1, redundancy: 0 })).toBeCloseTo(1);
    expect(semanticFitOf({ relevance: 0, appropriateness: 0, redundancy: 1 })).toBeCloseTo(0);
    expect(semanticFitOf({ relevance: 1, appropriateness: 0.5, redundancy: 0.5 })).toBeCloseTo(0.7);
  });

  it('gives candidates short refs, caps the shortlist and keeps long identifiers out of the context', () => {
    const shortlist = Array.from({ length: JEV_SHORTLIST_LIMIT + 5 }, (_, i) => encounter(i));
    const { context, candidatesByRef } = jevContext(encounter(99), shortlist);
    expect(context.items).toHaveLength(JEV_SHORTLIST_LIMIT + 1);
    expect(context.items[0]).toMatchObject({ ref: 'step', kind: 'current_step' });
    expect(context.items[1]).toMatchObject({ ref: 'c1', kind: 'candidate' });
    expect(candidatesByRef.size).toBe(JEV_SHORTLIST_LIMIT);
    expect(JSON.stringify(context)).not.toContain('asset-3');
  });

  it('accepts only known refs once each and keeps every criterion in range', () => {
    const { candidatesByRef } = jevContext(encounter(99), [encounter(1), encounter(2)]);
    const entry = { relevance: 0.9, appropriateness: 0.8, redundancy: 0.1 };
    const accepted = acceptAssessments(
      {
        assessments: [
          { ref: 'c1', ...entry },
          { ref: 'c9', ...entry },
          { ref: 'c1', ...entry, relevance: 0 },
        ],
      },
      candidatesByRef,
    );
    expect(accepted).toEqual([{ assetId: 'asset-1', assetRevision: 1, ...entry }]);
    expect(JEV_ROLE.outputSchema.safeParse({ assessments: [{ ref: 'c1', ...entry, relevance: 1.2 }] }).success).toBe(
      false,
    );
    expect(JEV_ROLE.outputSchema.safeParse({ assessments: [{ ref: 'c1', ...entry, extra: 1 }] }).success).toBe(false);
    expect(JEV_ROLE.outputSchema.safeParse({ assessments: [] }).success).toBe(false);
  });

  it('stores assessments with the role and prompt versions, the model and a lifetime', () => {
    const stored = storedAssessments({
      entries: [],
      model: 'fixture-model',
      assessedAt: new Date('2026-10-20T12:00:00Z'),
      lifetimeMs: 30 * 60_000,
    });
    expect(stored).toMatchObject({
      roleVersion: 'jev.1/hp2',
      model: 'fixture-model',
      assessedAt: '2026-10-20T12:00:00.000Z',
      expiresAt: '2026-10-20T12:30:00.000Z',
    });
  });

  const authority = { universeId: 'u', privacyEpoch: 1, actor: { kind: 'system', purpose: 'test' } } as const;
  const harnessReturning = (outcome: ProposeOutcome<unknown>): ReasoningHarness => ({
    propose: <T>(_input: ProposeInput<T>) => Promise.resolve(outcome as ProposeOutcome<T>),
    closeRun: () => Promise.resolve('closed' as const),
  });
  const assess = (outcome: ProposeOutcome<unknown>) =>
    makeAssessShortlist(harnessReturning(outcome))({
      runId: '00000000-0000-4000-8000-000000000001',
      authority,
      source: encounter(99),
      shortlist: [encounter(1)],
      signal: new AbortController().signal,
    });

  it('treats every provider failure as the absence of an assessment', async () => {
    const usage = { inputTokens: 1, outputTokens: 1, reasoningTokens: null, cachedTokens: null };
    const proposed = await assess({
      kind: 'proposed',
      output: { assessments: [{ ref: 'c1', relevance: 1, appropriateness: 1, redundancy: 0 }] },
      attemptId: 'a',
      usage,
      repaired: false,
      reconciled: false,
    });
    expect(proposed).toMatchObject({ kind: 'assessed', end: 'completed' });
    expect(await assess({ kind: 'invalid_output', attemptId: 'a', reason: 'x' })).toEqual({
      kind: 'absent',
      reason: 'invalid_output',
      end: 'failed',
    });
    expect(await assess({ kind: 'failed', attemptId: 'a', code: 'HTTP_500' })).toMatchObject({
      kind: 'absent',
      end: 'failed',
    });
    expect(await assess({ kind: 'unknown', attemptId: 'a' })).toEqual({ kind: 'absent', reason: 'unknown_outcome' });
    expect(await assess({ kind: 'refused', reason: 'provider_unavailable' })).toEqual({
      kind: 'absent',
      reason: 'refused_provider_unavailable',
    });
    expect(await assess({ kind: 'budget_exhausted', dimension: 'role', limit: 'requests' })).toMatchObject({
      kind: 'absent',
      end: 'cancelled',
    });
  });
});
