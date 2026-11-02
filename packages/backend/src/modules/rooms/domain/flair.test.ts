import { describe, expect, it } from 'vitest';
import {
  FLAIR_NEEDED,
  FLAIR_ORDER,
  comingFlair,
  earnedFlair,
  mayChoose,
  progressOf,
  shownFlair,
  type FlairActs,
} from './flair.js';

const none: FlairActs = { answers: 0, goodQuestions: 0, flawsFound: 0, launchesPlayed: 0 };
const acts = (patch: Partial<FlairActs>): FlairActs => ({ ...none, ...patch });

describe('which acts earn which flair (R3 E5)', () => {
  it('earns nothing from nothing', () => {
    expect(earnedFlair(none)).toEqual([]);
    expect(comingFlair(none)).toEqual([]);
  });

  it('gives First answer for the first words in Today or in someone else’s question', () => {
    expect(earnedFlair(acts({ answers: 1 }))).toEqual(['first_answer']);
    expect(earnedFlair(acts({ answers: 40 }))).toEqual(['first_answer']);
  });

  it('gives the others for three acts, and shows the way there for one or two of the person’s own acts', () => {
    for (const [kind, key] of [
      ['flaw_finder', 'flawsFound'],
      ['launch_regular', 'launchesPlayed'],
    ] as const) {
      expect(earnedFlair(acts({ [key]: 2 })), kind).toEqual([]);
      expect(comingFlair(acts({ [key]: 2 })), kind).toEqual([{ flair: kind, have: 2, of: FLAIR_NEEDED[kind] }]);
      expect(earnedFlair(acts({ [key]: 3 })), kind).toEqual([kind]);
      expect(comingFlair(acts({ [key]: 3 })), kind).toEqual([]);
    }
  });

  it('gives Good question for three marked questions, and says nothing of how many are marked before that (D-168)', () => {
    for (const marked of [1, 2]) {
      expect(earnedFlair(acts({ goodQuestions: marked })), String(marked)).toEqual([]);
      expect(comingFlair(acts({ goodQuestions: marked })), String(marked)).toEqual([]);
    }
    expect(earnedFlair(acts({ goodQuestions: 3 }))).toEqual(['good_question']);
    expect(comingFlair(acts({ goodQuestions: 3 }))).toEqual([]);
  });

  it('lists what is earned in the card’s order whatever the order of the acts', () => {
    const everything = acts({ answers: 1, goodQuestions: 3, flawsFound: 3, launchesPlayed: 3 });
    expect(earnedFlair(everything)).toEqual(FLAIR_ORDER);
  });

  it('never counts past what a mark needs, or below nothing', () => {
    expect(progressOf('flaw_finder', acts({ flawsFound: 99 }))).toBe(3);
    expect(progressOf('flaw_finder', acts({ flawsFound: -4 }))).toBe(0);
  });
});

describe('what shows beside a name', () => {
  const earned = ['first_answer', 'flaw_finder'] as const;

  it('shows the first earned mark while the choice is automatic', () => {
    expect(shownFlair(null, earned)).toBe('first_answer');
    expect(shownFlair(null, [])).toBeUndefined();
  });

  it('shows nothing when the person hid it, whatever they earned', () => {
    expect(shownFlair('none', earned)).toBeUndefined();
  });

  it('shows a chosen mark only while it is earned, and does not put another in its place', () => {
    expect(shownFlair('flaw_finder', earned)).toBe('flaw_finder');
    expect(shownFlair('launch_regular', earned)).toBeUndefined();
  });

  it('lets a person hide or go automatic at any time, and choose only what they earned', () => {
    expect(mayChoose('none', [])).toBe(true);
    expect(mayChoose('auto', [])).toBe(true);
    expect(mayChoose('first_answer', earned)).toBe(true);
    expect(mayChoose('good_question', earned)).toBe(false);
  });
});
