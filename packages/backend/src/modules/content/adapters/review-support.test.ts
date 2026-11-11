import { describe, expect, it } from 'vitest';
import type { LibrarySentenceResult } from '../domain/library-support.js';
import type { StoredLibraryCheck } from '../production/library-support-store.js';
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
  checkerVersion: 'library-support-check.v1',
  state: 'checked',
  code: null,
  verdict: 'passed',
  policyVersion: 'library-support-policy.v1',
  round: 1,
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
      checkerVersion: 'library-support-check.v1',
      policy: 'library-support-policy.v1',
      state: 'checked',
      verdict: 'flagged',
      counts: { sentences: 4, supported: 1, unsupported: 1, unclear: 1, noClaim: 1 },
    });
    expect(JSON.stringify(summary)).not.toContain('Sentence 2');
    expect(JSON.stringify(summary)).not.toContain('narrower');
  });

  it('summarises a check that gave nothing with its code and the sentences it could not check', () => {
    const none = stored([], { state: 'unchecked', code: 'outcome_unknown', verdict: 'unchecked', sentenceCount: 57 });
    expect(supportCheckSummaryOf(none)).toEqual({
      checkerVersion: 'library-support-check.v1',
      policy: 'library-support-policy.v1',
      state: 'unchecked',
      verdict: 'unchecked',
      code: 'outcome_unknown',
      counts: { sentences: 57, supported: 0, unsupported: 0, unclear: 0, noClaim: 0 },
    });
  });

  it('says that no check ran, so the operator reads every sentence against its sources', () => {
    expect(supportCheckLines(null)).toEqual([
      'Support check: not run for this revision yet. Read every sentence against its sources.',
    ]);
  });

  it('says that a check gave nothing, and why', () => {
    expect(
      supportCheckLines(
        stored([], { state: 'unchecked', code: 'revision_too_long', verdict: 'unchecked', sentenceCount: 140 }),
      ),
    ).toEqual([
      'Support check: NOT CHECKED (revision_too_long). No sentence has a verdict. Read every sentence against its sources.',
    ]);
  });

  it('passes a revision whose sentences are all supported or state no fact, and lists nothing to read first', () => {
    expect(supportCheckLines(stored([result(1), result(2, { outcome: 'no_claim' })]))).toEqual([
      'Support check: PASSED (library-support-check.v1, library-support-policy.v1). 2 sentences: 1 supported, 0 unsupported, 0 unclear, 1 state no fact.',
    ]);
  });

  it('flags a revision and lists the unsupported and unclear sentences first, each with where it stands and why', () => {
    expect(supportCheckLines(flagged)).toEqual([
      'Support check: FLAGGED (library-support-check.v1, library-support-policy.v1). 4 sentences: 1 supported, 1 unsupported, 1 unclear, 1 state no fact.',
      'Read these first:',
      '  [s1 twist #2] unsupported (goes_beyond): Sentence 2 of a labelled CI fixture. -- A passage says something narrower.',
      '  [a1 aside-text #3] unclear (quote_not_about_sentence): Sentence 3 of a labelled CI fixture.',
    ]);
  });
});
