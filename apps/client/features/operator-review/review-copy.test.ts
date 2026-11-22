import { answerChip, findingsOf, heldSince, refusalWords, supportChip, worstTone } from './review-copy';
import { fixtureShow } from './review-fixtures';

describe('what the checks say, in plain words', () => {
  const finding = (id: string, overrides = {}) => findingsOf(fixtureShow(overrides)).find((entry) => entry.id === id);

  it('says a document v3 Scroll has no calls to check, which is no cause to worry', () => {
    expect(finding('answers')?.tone).toBe('note');
    expect(finding('answers')?.text).toContain('no calls to check');
  });

  it('flags the support check with its counts and where to start reading', () => {
    expect(finding('support')?.tone).toBe('attention');
    expect(finding('support')?.text).toContain(
      '40 sentences: 36 supported, 1 unsupported, 1 unclear, 2 state no fact.',
    );
    expect(finding('support')?.text).toContain('Read the sentences listed below first.');
  });

  it('says plainly when a check has not run, because that is also a fact about how much to trust the read', () => {
    expect(finding('support', { supportCheck: null })).toMatchObject({
      tone: 'attention',
      text: 'Support check: not run yet. Read every sentence against its sources.',
    });
    expect(
      finding('support', {
        supportCheck: {
          ...fixtureShow().supportCheck!,
          verdict: 'unchecked',
          code: 'provider_failed_final',
          attention: [],
        },
      })?.text,
    ).toContain('not checked (provider_failed_final)');
  });

  it('passes the support check in one line with no sentences to read first', () => {
    const passed = fixtureShow({
      supportCheck: { ...fixtureShow().supportCheck!, verdict: 'passed', attention: [] },
    });
    expect(findingsOf(passed).find((entry) => entry.id === 'support')?.tone).toBe('ok');
  });

  it('says what a v2 Scroll’s answer check found, by the call and the problem', () => {
    const answers = (check: NonNullable<ReturnType<typeof fixtureShow>['answerCheck']>) => {
      const review = fixtureShow({ answerCheck: check });
      return findingsOf({
        ...review,
        document: { ...review.document, schemaVersion: 'scroll-document.v2' } as never,
      }).find((entry) => entry.id === 'answers');
    };
    expect(answers({ outcome: 'passed', calls: 4, code: null, flags: [] })?.text).toContain('All 4 calls agree');
    expect(
      answers({ outcome: 'flagged', calls: null, code: null, flags: [{ id: 'c2', problem: 'The key is B.' }] }),
    ).toEqual({
      id: 'answers',
      tone: 'attention',
      text: 'Answer check: flagged. 1 call flagged and not cleared: c2 (The key is B.).',
    });
    expect(answers({ outcome: 'unchecked', calls: null, code: 'unusable', flags: [] })?.text).toContain(
      'not checked (unusable)',
    );
  });

  it('asks for coverage before a document v3 can be released, and only notes it for a v2 Scroll', () => {
    expect(finding('coverage', { coverage: 'unmapped' })?.tone).toBe('attention');
    expect(finding('coverage', { coverage: 'unmapped' })?.text).toContain('cannot be released until it is');
    expect(finding('coverage')?.tone).toBe('ok');
  });

  it('names the topic, or says there is none yet', () => {
    expect(finding('topic')?.text).toBe('Topic: earth.cholera.');
    expect(finding('topic', { topic: null })?.text).toBe('Topic: none attributed yet.');
  });

  it('draws a row’s chips in words and reports the worst tone of the findings', () => {
    expect(answerChip(null)).toEqual({ text: 'Answers: none', tone: 'note' });
    expect(answerChip('flagged').tone).toBe('attention');
    expect(supportChip(null)).toEqual({ text: 'Support: not run', tone: 'attention' });
    expect(supportChip('passed').tone).toBe('ok');
    expect(worstTone(findingsOf(fixtureShow()))).toBe('attention');
  });

  it('writes the time a Scroll was held in UTC to the minute, and every refusal the gate can give in words', () => {
    expect(heldSince('2026-11-21T09:30:12.000Z')).toBe('held 2026-11-21 09:30 UTC');
    for (const reason of ['coverage_missing', 'not_newer_than_served', 'asset_withdrawn', 'revision_rejected'] as const)
      expect(refusalWords(reason)).toMatch(/^It was not released/);
    expect(refusalWords('revision_released')).toMatch(/^It was not rejected/);
  });
});
