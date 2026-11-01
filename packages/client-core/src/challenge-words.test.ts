import { describe, expect, it } from 'vitest';
import type { ChallengeCard } from '@knowscroll/contracts';
import { challengeNoticeWords, challengeRevealWords, challengeStatusWords } from './challenge-words';

const base = {
  stopId: 'tides-call',
  prompt: 'When are tides biggest?',
  options: ['Full and new moon', 'Half moon', 'Always the same'],
};
const revealed = (right: boolean): Extract<ChallengeCard, { stage: 'revealed' }> => ({
  ...base,
  stage: 'revealed',
  option: right ? 0 : 1,
  theirs: 2,
  answer: 0,
  explain: 'Spring tides come at full and new moon.',
  right,
  theirsRight: false,
  ...(right ? {} : { twist: 'Half moon gives the smaller neap tides.' }),
});

describe('what a challenge says', () => {
  it('says nothing of the friend’s call before the person has called', () => {
    const words = challengeStatusWords({ ...base, stage: 'open' }, 'Ravi');
    expect(words).toContain('Ravi');
    expect(words).not.toMatch(/\b[ABC]\b/);
  });

  it('names only the person’s own letter while they wait', () => {
    expect(challengeStatusWords({ ...base, stage: 'locked', option: 1 }, 'Ravi')).toBe(
      'You called B. Ravi’s call shows once they have called too.',
    );
  });

  it('names both letters once both have called', () => {
    expect(challengeStatusWords(revealed(false), 'Ravi')).toBe('You called B. Ravi called C.');
  });

  it('gives a right call a spark and a wrong one a plot twist with no spark and no loss', () => {
    expect(challengeRevealWords(revealed(true))).toEqual({ title: 'Called it!', spark: '+1 spark' });
    const wrong = challengeRevealWords(revealed(false));
    expect(wrong).toEqual({ title: 'Plot twist!', spark: undefined });
    expect(JSON.stringify(wrong)).not.toMatch(/-1|lost|wrong|miss/i);
  });

  it('explains a paused recording and a failed pick plainly', () => {
    expect(challengeNoticeWords('paused').lead).toBe('Recording is paused.');
    expect(challengeNoticeWords('failed').message).toBe('Nothing was saved. Try again.');
  });
});
