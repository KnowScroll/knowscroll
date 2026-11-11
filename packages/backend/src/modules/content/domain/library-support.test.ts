import { describe, expect, it } from 'vitest';
import type { SentenceVerdict } from './ask-support.js';
import {
  LIBRARY_CHECK_RULES,
  LIBRARY_SUPPORT_POLICY,
  MAX_DANGEROUS_RATE,
  agreementOf,
  countsOf,
  decideRevision,
  rateOf,
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

const passageTexts = new Map([['e1', 'A passage of a labelled CI fixture, with a few words in it.']]);

describe('what became of each sentence (D-415)', () => {
  const sentences = [
    sentence(1, { part: 'title', field: 'title', label: true, text: 'How a lamp turns' }),
    sentence(2),
    sentence(3),
    sentence(4),
    sentence(5),
  ];
  const verdicts: readonly SentenceVerdict[] = [
    { number: 1, verdict: 'no_claim' },
    { number: 2, verdict: 'supported', quote: 'words of a labelled CI fixture' },
    { number: 3, verdict: 'unsupported', kind: 'goes_beyond', problem: 'A passage says something narrower.' },
    // Code set this one aside: the checker's quote was not in any passage the sentence cites.
    {
      number: 4,
      verdict: 'unsupported',
      kind: 'not_stated',
      problem: 'The words the checker quoted for this sentence are not in any passage the answer cites.',
      code: 'quote_not_in_cited_passages',
    },
    { number: 5, verdict: 'supported', quote: 'few words in it' },
  ];
  const quotes = new Map([
    [2, 'words of a labelled CI fixture'],
    [4, 'words that no cited passage ever held'],
    [5, 'few words in it'],
  ]);
  const results = resultsOf(sentences, verdicts, { quotes, passageTexts });

  it('is supported, unsupported, unclear or no claim: a verdict code set aside is unclear, never unsupported', () => {
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

  it('keeps the ground of a sentence passed as stating no fact', () => {
    // A title of four words or fewer that only names what follows.
    const label = resultsOf(
      [sentence(1, { part: 'title', field: 'title', label: true, text: 'How a lamp turns' })],
      [{ number: 1, verdict: 'no_claim' }],
      { quotes: new Map(), passageTexts },
    );
    expect(label[0]).toMatchObject({ outcome: 'no_claim', ground: 'label' });
    const gap = resultsOf([sentence(1, { text: 'The pages do not say.' })], [{ number: 1, verdict: 'no_claim' }], {
      quotes: new Map(),
      passageTexts,
    });
    expect(gap[0]).toMatchObject({ outcome: 'no_claim', ground: 'gap' });
  });

  it('keeps the quote and how it stands to the sentence, for a supported sentence and for one code set aside, so a stricter rule can be applied later', () => {
    expect(results[1]).toMatchObject({
      quote: 'words of a labelled CI fixture',
      keyWords: expect.any(Number) as number,
      quoteKeyWords: expect.any(Number) as number,
      shared: expect.any(Number) as number,
    });
    // Sentence 2 shares "labelled" and "fixture" with its quote, and the figures stored are what the rules count.
    expect(results[1]!.shared).toBeGreaterThanOrEqual(2);
    expect(results[3]).toMatchObject({ quote: 'words that no cited passage ever held', shared: 0 });
    // The checker's own unsupported finding has no quote: nothing was quoted for it.
    expect(results[2]).not.toHaveProperty('quote');
  });

  it('never counts a sentence without a verdict as supported', () => {
    expect(resultsOf([sentence(1)], [], { quotes: new Map(), passageTexts }).map((result) => result.outcome)).toEqual([
      'unclear',
    ]);
  });

  it('counts each outcome, and how many sentences passed as a label or an admission', () => {
    expect(countsOf(results)).toEqual({
      sentences: 5,
      supported: 2,
      unsupported: 1,
      unclear: 1,
      noClaim: 1,
      noClaimLabel: 1,
    });
  });
});

describe('the rules of the library check (D-415)', () => {
  it('asks for the quote from the sentence’s own passages and does not let "no fact" rest on sharing no word', () => {
    expect(LIBRARY_CHECK_RULES).toEqual({
      shortNoClaim: false,
      oneKeyWordAbout: true,
      ownPassagesOnly: true,
      noClaimUnshared: false,
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
    noClaimLabel: 2,
    ...overrides,
  });

  it('passes under the first policy only when no sentence is unsupported or unclear and few passed as labels', () => {
    expect(LIBRARY_SUPPORT_POLICY).toMatchObject({ maxUnsupported: 0, maxUnclear: 0, maxLabelNoClaim: 8 });
    expect(decideRevision(counts())).toBe('passed');
    expect(decideRevision(counts({ unsupported: 1, supported: 49 }))).toBe('flagged');
    expect(decideRevision(counts({ unclear: 1, supported: 49 }))).toBe('flagged');
  });

  it('caps the labels and admissions passed as stating no fact, since they pass without a quote', () => {
    expect(decideRevision(counts({ noClaim: 8, noClaimLabel: 8 }))).toBe('passed');
    expect(decideRevision(counts({ noClaim: 9, noClaimLabel: 9, supported: 51 }))).toBe('flagged');
    // Other kinds of no-claim are not labels: they are not counted against the cap.
    expect(decideRevision(counts({ noClaim: 20, noClaimLabel: 3 }))).toBe('passed');
  });

  it('applies a looser policy by its limits, and null is no limit', () => {
    const loose = { id: 'ci-loose', maxUnsupported: 1, maxUnclear: null, maxLabelNoClaim: null };
    expect(decideRevision(counts({ unsupported: 1 }), loose)).toBe('passed');
    expect(decideRevision(counts({ unsupported: 2 }), loose)).toBe('flagged');
    expect(decideRevision(counts({ unclear: 40 }), loose)).toBe('passed');
    expect(decideRevision(counts({ noClaimLabel: 30 }), loose)).toBe('passed');
  });
});

describe('how far a rate can be trusted', () => {
  it('gives the rule of three when nothing happened, and a Wilson interval that does not shrink to zero with it', () => {
    expect(rateOf(0, 30)).toEqual({ k: 0, n: 30, rate: 0, wilsonLower: 0, wilsonUpper: 0.114, ruleOfThree: 0.1 });
    expect(rateOf(0, 10)).toMatchObject({ ruleOfThree: 0.3, wilsonUpper: 0.278 });
    expect(rateOf(0, 5).wilsonUpper!).toBeGreaterThan(0.4);
  });

  it('gives the Wilson interval around a rate and no rule of three when something happened', () => {
    const rate = rateOf(3, 10);
    expect(rate).toMatchObject({ k: 3, n: 10, rate: 0.3, ruleOfThree: null });
    expect(rate.wilsonLower!).toBeLessThan(0.3);
    expect(rate.wilsonUpper!).toBeGreaterThan(0.3);
    expect(rate.wilsonUpper!).toBeLessThanOrEqual(1);
  });

  it('says nothing when there is nothing to divide', () => {
    expect(rateOf(0, 0)).toEqual({ k: 0, n: 0, rate: null, wilsonLower: null, wilsonUpper: null, ruleOfThree: null });
  });
});

describe('how the check agrees with the operator’s decisions', () => {
  const clean: LibraryCounts = {
    sentences: 50,
    supported: 45,
    unsupported: 0,
    unclear: 0,
    noClaim: 5,
    noClaimLabel: 2,
  };
  const oneUnsupported: LibraryCounts = { ...clean, supported: 44, unsupported: 1 };
  const twoUnclear: LibraryCounts = { ...clean, supported: 43, unclear: 2 };
  const day = (n: number, hour = 12) =>
    `2026-11-${String(n).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
  /** A decision on day `decided`, checked on day `checked` (the check made after the decision unless said), by default the next day. */
  const row = (
    decision: DecidedCheck['decision'],
    family: string,
    counts: LibraryCounts | null,
    options: { decided?: number; checked?: number | null; code?: string } = {},
  ): DecidedCheck => {
    const decided = options.decided ?? 1;
    const checked = options.checked === undefined ? decided + 1 : options.checked;
    return {
      decision,
      family,
      decidedAt: day(decided),
      checkedAt: checked === null ? null : day(checked),
      counts,
      ...(options.code === undefined ? {} : { code: options.code }),
    };
  };

  const rows: readonly DecidedCheck[] = [
    row('released', 'earth', clean, { decided: 1 }),
    row('released', 'earth', clean, { decided: 2 }),
    row('released', 'earth', oneUnsupported, { decided: 3 }),
    row('released', 'space', twoUnclear, { decided: 4 }),
    row('rejected', 'earth', oneUnsupported, { decided: 5 }),
    row('rejected', 'space', clean, { decided: 6 }),
    row('rejected', 'space', null, { decided: 7, checked: null, code: 'outcome_unknown' }),
    row('released', 'space', null, { decided: 8, checked: null, code: 'revision_too_long' }),
    row('rejected', 'space', null, { decided: 9, checked: null, code: 'outcome_unknown' }),
  ];

  it('counts released and rejected revisions by what the check said, with the rejected ones it would have passed as the dangerous number', () => {
    const report = agreementOf(rows);
    expect(report).toMatchObject({
      policy: 'library-support-policy.v2',
      decided: 9,
      checked: 6,
      released: 4,
      rejected: 2,
      releasedPassed: 2,
      releasedFlagged: 2,
      rejectedPassed: 1,
      rejectedFlagged: 1,
    });
    expect(report.rejectedCaught).toBe(0.5);
    expect(report.releasedPassedShare).toBe(0.5);
    expect(report.agreement).toBe(0.5);
  });

  it('counts only the decisions made before a result existed: one the operator could have seen is kept apart, and so is one with no time to compare', () => {
    // A rejected revision the check passes, but whose result was made before the operator decided: it is not in the matrix.
    const withExposed = [...rows, row('rejected', 'earth', clean, { decided: 10, checked: 9 })];
    const report = agreementOf(withExposed);
    expect(report).toMatchObject({ decided: 10, checked: 6, rejectedPassed: 1, rejectedFlagged: 1 });
    expect(report.exposed).toEqual({
      releasedPassed: 0,
      releasedFlagged: 0,
      rejectedPassed: 1,
      rejectedFlagged: 0,
      checked: 1,
    });
    // A result made at the very moment of the decision cannot have been seen before it.
    expect(agreementOf([row('rejected', 'earth', clean, { decided: 3, checked: 3 })])).toMatchObject({
      checked: 1,
      rejectedPassed: 1,
    });
    // The exposed ones are in no half of the matrix, in no family and in no choice.
    expect(report.byFamily['earth']).toEqual({
      releasedPassed: 2,
      releasedFlagged: 1,
      rejectedPassed: 0,
      rejectedFlagged: 1,
      checked: 4,
    });
    expect(report.notChecked.total).toBe(3);
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

  it('reports how far the dangerous number can be trusted: n, rejected n, the Wilson bound and the rule of three', () => {
    const report = agreementOf(rows);
    expect(report.rejectedPassedRate).toMatchObject({ k: 1, n: 2, rate: 0.5, ruleOfThree: null });
    expect(report.rejectedPassedRate.wilsonUpper!).toBeGreaterThan(0.8);
    expect(report.flagRate).toMatchObject({ k: 3, n: 6, rate: 0.5 });
    expect(report.releasedFlaggedRate).toMatchObject({ k: 2, n: 4 });
    // None passed out of the rejected ones: the rule of three.
    const none = agreementOf(
      Array.from({ length: 12 }, (_, index) => row('rejected', 'earth', oneUnsupported, { decided: index + 1 })),
    );
    expect(none.rejectedPassedRate).toMatchObject({ k: 0, n: 12, rate: 0, ruleOfThree: 0.25 });
  });

  it('reads the same results under looser limits without another check, from the strictest up', () => {
    const { choices } = agreementOf(rows);
    const choice = (maxUnsupported: number | null, maxUnclear: number | null) =>
      choices.find((entry) => entry.maxUnsupported === maxUnsupported && entry.maxUnclear === maxUnclear)!;
    expect(choice(0, 0)).toMatchObject({ releasedPassed: 2, rejectedPassed: 1, rejectedFlagged: 1 });
    expect(choice(1, 0)).toMatchObject({ rejectedPassed: 2, rejectedFlagged: 0, releasedFlagged: 1 });
    expect(choice(1, 2)).toMatchObject({ releasedPassed: 4, releasedFlagged: 0 });
    for (const strict of choices)
      for (const loose of choices) {
        const looser =
          (loose.maxUnsupported === null ||
            (strict.maxUnsupported !== null && loose.maxUnsupported >= strict.maxUnsupported)) &&
          (loose.maxUnclear === null || (strict.maxUnclear !== null && loose.maxUnclear >= strict.maxUnclear));
        if (looser) expect(loose.rejectedPassed).toBeGreaterThanOrEqual(strict.rejectedPassed);
      }
  });

  describe('the older decisions choose and the newer ones report', () => {
    // Twelve blind decisions in time order: the older six hold three rejected revisions the strict limits catch, the newer six hold rejected ones too.
    const decisions: DecidedCheck[] = [
      row('released', 'earth', clean, { decided: 1 }),
      row('released', 'earth', twoUnclear, { decided: 2 }),
      row('rejected', 'earth', oneUnsupported, { decided: 3 }),
      row('rejected', 'earth', oneUnsupported, { decided: 4 }),
      row('rejected', 'earth', oneUnsupported, { decided: 5 }),
      row('released', 'earth', clean, { decided: 6 }),
      row('released', 'earth', clean, { decided: 7 }),
      row('rejected', 'earth', oneUnsupported, { decided: 8 }),
      row('rejected', 'earth', clean, { decided: 9 }),
      row('released', 'earth', oneUnsupported, { decided: 10 }),
      row('rejected', 'earth', oneUnsupported, { decided: 11 }),
      row('released', 'earth', clean, { decided: 12 }),
    ];

    it('splits the blind decisions in time, chooses limits on the older half alone and reports the newer half under the policy and under the choice', () => {
      const { split } = agreementOf(decisions);
      expect(split.selection).toMatchObject({ n: 6, rejected: 3 });
      expect(split.evaluation).toMatchObject({ n: 6, rejected: 3 });
      expect(Date.parse(split.selection.until!)).toBeLessThan(Date.parse(split.evaluation.from!));
      // Of the limits that pass none of the older half's rejected revisions, the one that passes the most released ones: two unclear sentences allowed.
      expect(split.chosen).toMatchObject({ maxUnsupported: 0, maxUnclear: 2, rejectedPassed: 0, releasedPassed: 3 });
      // The newer half is read under the active policy and under the choice, which never saw it.
      expect(split.evaluationUnderPolicy).toMatchObject({ checked: 6, rejectedPassed: 1, rejectedFlagged: 2 });
      expect(split.evaluationUnderChosen).toMatchObject({ checked: 6, rejectedPassed: 1, rejectedFlagged: 2 });
      expect(split.evaluationUnderPolicy.rejectedPassedRate).toMatchObject({ k: 1, n: 3 });
    });

    it('chooses nothing when the older half holds too few rejected revisions, and says so', () => {
      const { split } = agreementOf(
        decisions.filter((entry) => entry.decision === 'released' || Date.parse(entry.decidedAt) > Date.parse(day(5))),
      );
      expect(split.chosen).toBeNull();
      expect(split.evaluationUnderChosen).toBeNull();
      expect(split.chosenReason).toMatch(/rejected revision\(s\); a policy is chosen from at least 3/u);
    });
  });

  describe('what the measure can conclude', () => {
    it('says plainly that it is not enough when the newer half has few rejected revisions, even when none passed', () => {
      const few = Array.from({ length: 12 }, (_, index) =>
        row(index % 2 === 0 ? 'released' : 'rejected', 'earth', index % 2 === 0 ? clean : oneUnsupported, {
          decided: index + 1,
        }),
      );
      const { conclusion, split } = agreementOf(few);
      expect(split.evaluationUnderPolicy.rejectedPassedRate).toMatchObject({ k: 0, n: 3 });
      expect(conclusion.enough).toBe(false);
      expect(conclusion.statement).toMatch(
        /^Not enough to conclude: 0 of 3 rejected revision\(s\) in the newer half passed; the 95% upper bound/u,
      );
      expect(conclusion.statement).toContain('Do not step review down on this.');
    });

    it('says it cannot be measured with no rejected revision in the newer half', () => {
      const released = Array.from({ length: 6 }, (_, index) => row('released', 'earth', clean, { decided: index + 1 }));
      expect(agreementOf(released).conclusion).toMatchObject({ enough: false });
      expect(agreementOf(released).conclusion.statement).toContain('no rejected revision');
      expect(agreementOf([]).conclusion.enough).toBe(false);
    });

    it('can conclude only when the upper bound of the rejected-passed rate in the newer half is at most the limit, which takes about thirty rejected revisions', () => {
      const many = Array.from({ length: 80 }, (_, index) =>
        row('rejected', 'earth', oneUnsupported, { decided: (index % 28) + 1, checked: (index % 28) + 2 }),
      );
      const { conclusion, split } = agreementOf(many);
      expect(split.evaluationUnderPolicy.rejectedPassedRate).toMatchObject({ k: 0, n: 40 });
      expect(split.evaluationUnderPolicy.rejectedPassedRate.wilsonUpper!).toBeLessThanOrEqual(MAX_DANGEROUS_RATE);
      expect(conclusion.enough).toBe(true);
      expect(conclusion.statement).toContain('0 of 40 rejected revision(s) in the newer half passed');
      expect(conclusion.statement).toContain('it does not make the check safe for another subject');
    });
  });

  it('has no shares when there is nothing to divide', () => {
    expect(agreementOf([])).toMatchObject({
      decided: 0,
      checked: 0,
      rejectedCaught: null,
      releasedPassedShare: null,
      agreement: null,
    });
    expect(agreementOf([row('released', 'earth', null, { checked: null, code: 'outcome_unknown' })])).toMatchObject({
      decided: 1,
      checked: 0,
      agreement: null,
    });
  });
});
