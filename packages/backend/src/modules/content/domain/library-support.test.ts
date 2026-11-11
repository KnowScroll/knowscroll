import { describe, expect, it } from 'vitest';
import type { SentenceVerdict } from './ask-support.js';
import {
  LIBRARY_SUPPORT_POLICY,
  agreementOf,
  countsOf,
  decideRevision,
  resultsOf,
  type DecidedCheck,
  type LibraryCounts,
  type LibrarySentence,
} from './library-support.js';

const sentence = (number: number, overrides: Partial<LibrarySentence> = {}): LibrarySentence => ({
  number,
  text: `Sentence ${String(number)} of a labelled CI fixture.`,
  cites: ['e1'],
  part: 's1',
  field: 'paragraph',
  ...overrides,
});

describe('what became of each sentence (D-415)', () => {
  const sentences = [
    sentence(1, { part: 'title', field: 'title', label: true }),
    sentence(2),
    sentence(3),
    sentence(4),
    sentence(5),
  ];
  const verdicts: readonly SentenceVerdict[] = [
    { number: 1, verdict: 'no_claim' },
    { number: 2, verdict: 'supported', quote: 'words of a cited passage' },
    { number: 3, verdict: 'unsupported', kind: 'goes_beyond', problem: 'A passage says something narrower.' },
    // Code set this one aside: the checker's quote was not in any cited passage.
    {
      number: 4,
      verdict: 'unsupported',
      kind: 'not_stated',
      problem: 'The words the checker quoted for this sentence are not in any passage the answer cites.',
      code: 'quote_not_in_cited_passages',
    },
    { number: 5, verdict: 'supported', quote: 'more words of a cited passage' },
  ];

  it('is supported, unsupported, unclear or no claim: a verdict code set aside is unclear, never unsupported', () => {
    const results = resultsOf(sentences, verdicts);
    expect(results.map((result) => result.outcome)).toEqual([
      'no_claim',
      'supported',
      'unsupported',
      'unclear',
      'supported',
    ]);
    expect(results[2]).toMatchObject({ kind: 'goes_beyond', problem: 'A passage says something narrower.' });
    expect(results[3]).toMatchObject({ code: 'quote_not_in_cited_passages' });
    expect(results[3]).not.toHaveProperty('kind');
    expect(results[3]).not.toHaveProperty('problem');
    expect(results[0]).toMatchObject({ label: true, part: 'title', field: 'title', n: 1 });
    expect(results[1]).not.toHaveProperty('label');
  });

  it('never counts a sentence without a verdict as supported', () => {
    expect(resultsOf([sentence(1)], []).map((result) => result.outcome)).toEqual(['unclear']);
  });

  it('counts each outcome', () => {
    expect(countsOf(resultsOf(sentences, verdicts))).toEqual({
      sentences: 5,
      supported: 2,
      unsupported: 1,
      unclear: 1,
      noClaim: 1,
    });
  });
});

describe('the revision verdict is code’s, from the counts and a policy', () => {
  const counts = (overrides: Partial<LibraryCounts> = {}): LibraryCounts => ({
    sentences: 60,
    supported: 50,
    unsupported: 0,
    unclear: 0,
    noClaim: 10,
    ...overrides,
  });

  it('passes under the first policy only when no sentence is unsupported and none is unclear', () => {
    expect(LIBRARY_SUPPORT_POLICY).toMatchObject({ maxUnsupported: 0, maxUnclear: 0 });
    expect(decideRevision(counts())).toBe('passed');
    expect(decideRevision(counts({ unsupported: 1, supported: 49 }))).toBe('flagged');
    expect(decideRevision(counts({ unclear: 1, supported: 49 }))).toBe('flagged');
  });

  it('applies a looser policy by its limits, and null is no limit', () => {
    const loose = { id: 'ci-loose', maxUnsupported: 1, maxUnclear: null };
    expect(decideRevision(counts({ unsupported: 1 }), loose)).toBe('passed');
    expect(decideRevision(counts({ unsupported: 2 }), loose)).toBe('flagged');
    expect(decideRevision(counts({ unclear: 40 }), loose)).toBe('passed');
  });
});

describe('how the check agrees with the operator’s decisions', () => {
  const clean: LibraryCounts = { sentences: 50, supported: 45, unsupported: 0, unclear: 0, noClaim: 5 };
  const oneUnsupported: LibraryCounts = { ...clean, supported: 44, unsupported: 1 };
  const twoUnclear: LibraryCounts = { ...clean, supported: 43, unclear: 2 };
  const row = (
    decision: DecidedCheck['decision'],
    family: string,
    counts: LibraryCounts | null,
    code?: string,
  ): DecidedCheck => ({ decision, family, counts, ...(code === undefined ? {} : { code }) });

  const rows: readonly DecidedCheck[] = [
    row('released', 'earth', clean),
    row('released', 'earth', clean),
    row('released', 'earth', oneUnsupported),
    row('released', 'space', twoUnclear),
    row('rejected', 'earth', oneUnsupported),
    row('rejected', 'space', clean),
    row('rejected', 'space', null, 'outcome_unknown'),
    row('released', 'space', null, 'revision_too_long'),
    row('rejected', 'space', null, 'outcome_unknown'),
  ];

  it('counts released and rejected revisions by what the check said, with the rejected ones it would have passed as the dangerous number', () => {
    const report = agreementOf(rows);
    expect(report).toMatchObject({
      policy: 'library-support-policy.v1',
      decided: 9,
      checked: 6,
      releasedPassed: 2,
      releasedFlagged: 2,
      rejectedPassed: 1,
      rejectedFlagged: 1,
    });
    expect(report.rejectedCaught).toBe(0.5);
    expect(report.releasedPassedShare).toBe(0.5);
    expect(report.agreement).toBe(0.5);
  });

  it('keeps revisions that were not checked out of the matrix and says why', () => {
    const report = agreementOf(rows);
    expect(report.notChecked).toEqual({ total: 3, byCode: { outcome_unknown: 2, revision_too_long: 1 } });
    expect(report.releasedPassed + report.releasedFlagged + report.rejectedPassed + report.rejectedFlagged).toBe(
      report.checked,
    );
  });

  it('reports each recipe family on its own', () => {
    const { byFamily } = agreementOf(rows);
    expect(byFamily['earth']).toEqual({
      releasedPassed: 2,
      releasedFlagged: 1,
      rejectedPassed: 0,
      rejectedFlagged: 1,
      checked: 4,
    });
    expect(byFamily['space']).toEqual({
      releasedPassed: 0,
      releasedFlagged: 1,
      rejectedPassed: 1,
      rejectedFlagged: 0,
      checked: 2,
    });
  });

  it('reads the same results under looser limits without another check, from the strictest up', () => {
    const { choices } = agreementOf(rows);
    const choice = (maxUnsupported: number | null, maxUnclear: number | null) =>
      choices.find((entry) => entry.maxUnsupported === maxUnsupported && entry.maxUnclear === maxUnclear)!;
    // The policy itself: one unsupported rejected revision caught, the clean rejected one passed.
    expect(choice(0, 0)).toMatchObject({ releasedPassed: 2, rejectedPassed: 1, rejectedFlagged: 1 });
    // One unsupported sentence allowed: the rejected revision with one is no longer caught.
    expect(choice(1, 0)).toMatchObject({ rejectedPassed: 2, rejectedFlagged: 0, releasedFlagged: 1 });
    // Two unclear allowed as well: the released revision with two unclear sentences passes.
    expect(choice(1, 2)).toMatchObject({ releasedPassed: 4, releasedFlagged: 0 });
    // A looser policy never passes fewer revisions than a stricter one.
    for (const strict of choices)
      for (const loose of choices) {
        const looser =
          (loose.maxUnsupported === null ||
            (strict.maxUnsupported !== null && loose.maxUnsupported >= strict.maxUnsupported)) &&
          (loose.maxUnclear === null || (strict.maxUnclear !== null && loose.maxUnclear >= strict.maxUnclear));
        if (looser) expect(loose.rejectedPassed).toBeGreaterThanOrEqual(strict.rejectedPassed);
      }
  });

  it('has no shares when there is nothing to divide', () => {
    expect(agreementOf([])).toMatchObject({
      decided: 0,
      checked: 0,
      rejectedCaught: null,
      releasedPassedShare: null,
      agreement: null,
    });
    expect(agreementOf([row('released', 'earth', null, 'outcome_unknown')])).toMatchObject({
      decided: 1,
      checked: 0,
      agreement: null,
    });
  });
});
