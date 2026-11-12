import { describe, expect, it } from 'vitest';
import { LIBRARY_SUPPORT_POLICY, type LibrarySentenceResult } from '../domain/library-support.js';
import type { StoredLibraryCheck } from '../production/library-support-store.js';
import { LIBRARY_SUPPORT_CHECK_VERSION, NOT_COVERED_LINE } from '../production/library-support.js';
import { supportCheckSummaryOf } from './review-gate.js';
import { supportCheckLines } from './review-text.js';

const result = (n: number, overrides: Partial<LibrarySentenceResult> = {}): LibrarySentenceResult => ({
  n,
  part: 's1',
  field: 'paragraph',
  text: `Sentence ${String(n)} of a labelled CI fixture.`,
  outcome: 'supported',
  ...overrides,
});

const stored = (
  sentences: readonly LibrarySentenceResult[],
  overrides: Partial<StoredLibraryCheck> = {},
): StoredLibraryCheck => ({
  assetId: '8a7d48fe-0397-4e00-91a8-b4700630880f',
  revision: 1,
  checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
  state: 'checked',
  code: null,
  verdict: 'passed',
  policyVersion: LIBRARY_SUPPORT_POLICY.id,
  round: 1,
  batchFailures: {},
  sentenceCount: sentences.length,
  batches: 1,
  requests: 1,
  sentences,
  checkedAt: '2026-11-11T12:00:00.000Z',
  ...overrides,
});

describe('what the operator is told about the support check (D-415, labelled CI fixtures)', () => {
  const flagged = stored(
    [
      result(1),
      result(2, {
        field: 'twist',
        outcome: 'unsupported',
        kind: 'goes_beyond',
        problem: 'A passage says something narrower.',
      }),
      result(3, { part: 'a1', field: 'aside-text', outcome: 'unclear', code: 'quote_not_about_sentence' }),
      result(4, { outcome: 'no_claim' }),
    ],
    { verdict: 'flagged' },
  );

  it('summarises a check as counts and a verdict decided again from its sentences under the current policy, never a sentence', () => {
    // The stored verdict says passed, but the sentences are what decide: one unsupported and one unclear flag it.
    const summary = supportCheckSummaryOf({ ...flagged, verdict: 'passed' });
    expect(summary).toEqual({
      checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
      policy: LIBRARY_SUPPORT_POLICY.id,
      state: 'checked',
      verdict: 'flagged',
      counts: { sentences: 4, supported: 1, unsupported: 1, unclear: 1, noClaim: 1, noClaimLabel: 0 },
    });
    expect(JSON.stringify(summary)).not.toContain('Sentence 2');
    expect(JSON.stringify(summary)).not.toContain('narrower');
  });

  it('summarises a check that gave nothing with its code and the sentences it could not check', () => {
    const none = stored([], { state: 'unchecked', code: 'outcome_unknown', verdict: 'unchecked', sentenceCount: 57 });
    expect(supportCheckSummaryOf(none)).toEqual({
      checkerVersion: LIBRARY_SUPPORT_CHECK_VERSION,
      policy: LIBRARY_SUPPORT_POLICY.id,
      state: 'unchecked',
      verdict: 'unchecked',
      code: 'outcome_unknown',
      counts: { sentences: 57, supported: 0, unsupported: 0, unclear: 0, noClaim: 0, noClaimLabel: 0 },
    });
  });

  it('says that no check ran, so the operator reads every sentence against its sources', () => {
    expect(supportCheckLines(null)).toEqual([
      'Support check: not run for this revision yet. Read every sentence against its sources.',
      NOT_COVERED_LINE,
    ]);
  });

  it('says that a check gave nothing, and why', () => {
    expect(
      supportCheckLines(
        stored([], { state: 'unchecked', code: 'revision_too_long', verdict: 'unchecked', sentenceCount: 140 }),
      ),
    ).toEqual([
      'Support check: NOT CHECKED (revision_too_long). No sentence has a verdict. Read every sentence against its sources.',
      NOT_COVERED_LINE,
    ]);
  });

  it('passes a revision whose sentences are all supported or state no fact, lists what passed as stating no fact and what is not covered, and nothing to read first', () => {
    const lines = supportCheckLines(
      stored([
        result(1),
        result(2, { outcome: 'no_claim', ground: 'label', label: true, field: 'heading', text: 'How it turns' }),
      ]),
    );
    expect(lines).toEqual([
      `Support check: PASSED (${LIBRARY_SUPPORT_CHECK_VERSION}, ${LIBRARY_SUPPORT_POLICY.id}). 2 sentences: 1 supported, 0 unsupported, 0 unclear, 1 state no fact.`,
      'Passed as stating no fact (no passage was quoted for them):',
      '  [s1 heading #2] label: How it turns',
      NOT_COVERED_LINE,
    ]);
    expect(lines.join('\n')).not.toContain('Read these first');
  });

  it('flags a revision and lists the unsupported and unclear sentences first, each with where it stands and why', () => {
    expect(supportCheckLines(flagged)).toEqual([
      `Support check: FLAGGED (${LIBRARY_SUPPORT_CHECK_VERSION}, ${LIBRARY_SUPPORT_POLICY.id}). 4 sentences: 1 supported, 1 unsupported, 1 unclear, 1 state no fact.`,
      'Passed as stating no fact (no passage was quoted for them):',
      '  [s1 paragraph #4] no ground: Sentence 4 of a labelled CI fixture.',
      'Read these first:',
      '  [s1 twist #2] unsupported (goes_beyond): Sentence 2 of a labelled CI fixture. -- A passage says something narrower.',
      '  [a1 aside-text #3] unclear (quote_not_about_sentence): Sentence 3 of a labelled CI fixture.',
      NOT_COVERED_LINE,
    ]);
  });
});
