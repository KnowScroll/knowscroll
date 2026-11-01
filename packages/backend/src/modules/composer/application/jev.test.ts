import { describe, expect, it } from 'vitest';
import type {
  PersonalRecordingProposeInput,
  ProposeOutcome,
  RecordingReasoningHarness,
  RunOwner,
} from '../../../reasoning/public.js';
import type { EncounterSnapshot } from '../../content/public.js';
import { JEV_SHORTLIST_LIMIT, semanticFitOf } from '../domain/jev.js';
import {
  JEV_ASSESSMENT_VERSION,
  JEV_ROLE,
  JEV_ROLE_VERSION,
  acceptAssessments,
  jevContext,
  makeAssessShortlist,
  storedAssessments,
} from './jev.js';

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

/** A v2 Scroll as Content derives it: public facts of the document, never of a reader. */
function game(index: number, extra: Partial<EncounterSnapshot> = {}): EncounterSnapshot {
  return {
    ...encounter(index),
    series: { seriesId: 'library.earth.seasons', seriesRevision: 1, part: 2 },
    traits: {
      playLevel: 'game',
      readingMinutes: 6.4,
      misconceptionClaim: 'The seasons happen because Earth moves closer to the Sun.',
      seriesTotal: 3,
    },
    ...extra,
  };
}

describe('jev.2 describes an item by its public facts (D-193)', () => {
  const textOf = (source: EncounterSnapshot, candidate: EncounterSnapshot) =>
    jevContext(source, [candidate]).context.items[1]!.text;

  it('says the kind, the play level, the minutes, the place in the series and the myth', () => {
    const text = textOf(encounter(99), game(1));
    expect(text).toContain('Kind: scroll, several questions to call, ending in a final one, about 6 min');
    expect(text).toContain('Series: part 2 of 3');
    expect(text).toContain('Corrects the common myth: The seasons happen because Earth moves closer to the Sun.');
    expect(text.indexOf('Title:')).toBeLessThan(text.indexOf('Summary:'));
  });

  it('describes a plain Scroll, a Reel and an item with no traits without inventing facts', () => {
    expect(textOf(encounter(99), encounter(1))).toContain('Kind: scroll, nothing to play');
    expect(textOf(encounter(99), encounter(1))).not.toMatch(/Series:|myth|min/);
    const reel = { ...encounter(2), kind: 'reel' as const, traits: { playLevel: 'plain' as const } };
    expect(textOf(encounter(99), reel)).toContain('Kind: reel, nothing to play');
    const stage = encounter(3);
    expect(textOf(encounter(99), { ...stage, traits: { playLevel: 'stage', readingMinutes: 0.3 } })).toContain(
      'Kind: scroll, a picture that changes as you read, or a single question to call, about 1 min',
    );
  });

  it('names the series only when the total is known, and never "2 of 3" without the part', () => {
    const noTotal = game(1, { traits: { playLevel: 'game' } });
    expect(textOf(encounter(99), noTotal)).not.toContain('Series:');
  });

  it('keeps the myth when the summary is long: the summary is cut, never the structure', () => {
    const long = game(1, { metadata: { kind: 'scroll', title: 'T', summary: 'x'.repeat(2000), language: 'en' } });
    const text = textOf(encounter(99), long);
    expect(text.length).toBeLessThanOrEqual(900);
    expect(text).toContain('Corrects the common myth:');
    expect(text).toContain('Series: part 2 of 3');
  });

  it('carries no play outcome: the context has no field a pick, a result, a spark or a tier could be in', () => {
    const { context } = jevContext(game(98), [game(1), game(2)]);
    const text = JSON.stringify(context).toLowerCase();
    for (const word of [
      'correct answer',
      'wrong',
      'spark',
      'combo',
      'gold',
      'tier',
      'picked',
      'called it',
      'plot twist',
    ])
      expect(text).not.toContain(word);
  });

  it('is a new role version, so an assessment made under jev.1 is never reused', () => {
    expect(JEV_ROLE_VERSION).toBe('jev.2');
    expect(JEV_ASSESSMENT_VERSION.startsWith('jev.2/')).toBe(true);
    expect(JEV_ROLE.instructions).toContain('Two items that correct the same common myth are redundant');
    expect(JEV_ROLE.instructions).toContain('do not reward or penalise a candidate for being in a series');
    expect(
      JEV_ROLE.outputSchema.safeParse({ assessments: [{ ref: 'c1', relevance: 1, appropriateness: 1, redundancy: 0 }] })
        .success,
    ).toBe(true);
  });
});

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
      roleVersion: 'jev.2/hp2',
      model: 'fixture-model',
      assessedAt: '2026-10-20T12:00:00.000Z',
      expiresAt: '2026-10-20T12:30:00.000Z',
    });
  });

  const authority = { universeId: 'u', privacyEpoch: 1, actor: { kind: 'system', purpose: 'test' } } as const;
  const owner: RunOwner = {
    accountId: '00000000-0000-4000-8000-0000000000a1',
    universeId: '00000000-0000-4000-8000-0000000000a2',
    privacyEpoch: 1,
    recordId: '00000000-0000-4000-8000-0000000000a3',
    recordingGeneration: 3,
  };
  /** A stand-in for the recording-aware harness: records what it was asked and answers `outcome`. */
  const harnessReturning = (outcome: ProposeOutcome<unknown>, seen: PersonalRecordingProposeInput<unknown>[] = []) =>
    ({
      contextDigest: () => 'c'.repeat(64),
      proposePersonal: <T>(input: PersonalRecordingProposeInput<T>) => {
        seen.push(input);
        return Promise.resolve(outcome as ProposeOutcome<T>);
      },
    }) as unknown as RecordingReasoningHarness;
  const assess = (
    outcome: ProposeOutcome<unknown>,
    runFor: RunOwner | null = owner,
    seen: PersonalRecordingProposeInput<unknown>[] = [],
  ) =>
    makeAssessShortlist(harnessReturning(outcome, seen))({
      runId: '00000000-0000-4000-8000-000000000001',
      authority,
      source: encounter(99),
      shortlist: [encounter(1)],
      owner: runFor ?? undefined,
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
    expect(await assess({ kind: 'invalid_output', attemptId: 'a', reason: 'x' })).toMatchObject({
      kind: 'absent',
      reason: 'invalid_output',
      end: 'failed',
    });
    expect(await assess({ kind: 'failed', attemptId: 'a', code: 'HTTP_500' })).toMatchObject({
      kind: 'absent',
      end: 'failed',
    });
    const unknown = await assess({ kind: 'unknown', attemptId: 'a' });
    // May have reached the provider: the run stays open, so the result names no end.
    expect(unknown).toMatchObject({ kind: 'absent', reason: 'unknown_outcome' });
    expect(unknown).not.toHaveProperty('end');
    expect(await assess({ kind: 'refused', reason: 'provider_unavailable' })).toMatchObject({
      kind: 'absent',
      reason: 'refused_provider_unavailable',
    });
    expect(await assess({ kind: 'budget_exhausted', dimension: 'role', limit: 'requests' })).toMatchObject({
      kind: 'absent',
      end: 'cancelled',
    });
  });

  it('stamps the run with the owner’s generation and the digest of what the model is sent, and returns the proof', async () => {
    const seen: PersonalRecordingProposeInput<unknown>[] = [];
    const result = await assess({ kind: 'failed', attemptId: 'a', code: 'HTTP_500' }, owner, seen);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.run).toMatchObject({ ownerModule: 'composer', purpose: 'jev-assessment' });
    const proof = {
      ownerModule: 'composer',
      purpose: 'jev-assessment',
      accountId: owner.accountId,
      recordingGeneration: 3,
      claimId: owner.recordId,
      businessRunId: '00000000-0000-4000-8000-000000000001',
      contextSha256: 'c'.repeat(64),
      modelContextSha256: 'c'.repeat(64),
    };
    expect(seen[0]?.recordingPurpose).toMatchObject(proof);
    expect(result).toMatchObject({ kind: 'absent', end: 'failed', purpose: proof });
  });

  it('makes no call and starts no run while recording is paused: there is no owner', async () => {
    const seen: PersonalRecordingProposeInput<unknown>[] = [];
    const result = await assess({ kind: 'failed', attemptId: 'a', code: 'HTTP_500' }, null, seen);
    expect(seen).toEqual([]);
    expect(result).toEqual({ kind: 'absent', reason: 'refused_scope_refused' });
  });
});
