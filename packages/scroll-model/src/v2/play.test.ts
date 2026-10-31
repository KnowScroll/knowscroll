import { describe, expect, it } from 'vitest';
import {
  COMBO_FOR_FINAL_BONUS,
  finalBonusReady,
  landmarkTier,
  NO_TALLY,
  sparksEarned,
  talliesAfterEach,
  tallyOf,
} from './play.js';

const run = (...correct: boolean[]) => correct.map((value) => ({ correct: value }));
/** A run whose last lock is the Final call. */
const runToFinal = (...correct: boolean[]) =>
  correct.map((value, index) => ({ correct: value, finalCall: index === correct.length - 1 }));

describe("the tally of a Scroll's calls", () => {
  it('is nothing before any call is locked', () => {
    expect(tallyOf([])).toEqual(NO_TALLY);
    expect(talliesAfterEach([])).toEqual([]);
  });

  it('earns a spark for each right call and builds the combo from right calls in a row', () => {
    expect(talliesAfterEach(run(true, true, true))).toEqual([
      { sparks: 1, combo: 1 },
      { sparks: 2, combo: 2 },
      { sparks: 3, combo: 3 },
    ]);
  });

  it('ends the combo on a wrong call and keeps every spark', () => {
    expect(talliesAfterEach(run(true, true, false, true))).toEqual([
      { sparks: 1, combo: 1 },
      { sparks: 2, combo: 2 },
      { sparks: 2, combo: 0 },
      { sparks: 3, combo: 1 },
    ]);
    expect(tallyOf(run(false, false))).toEqual(NO_TALLY);
  });
});

describe('the Final call and its combo bonus (D-187)', () => {
  it('doubles a right Final call after a combo of two, and only then', () => {
    expect(COMBO_FOR_FINAL_BONUS).toBe(2);
    expect(talliesAfterEach(runToFinal(true, true, true)).at(-1)).toEqual({ sparks: 4, combo: 3 });
    expect(talliesAfterEach(runToFinal(true, true, true, true)).at(-1)).toEqual({ sparks: 5, combo: 4 });
    expect(talliesAfterEach(runToFinal(true, true)).at(-1)).toEqual({ sparks: 2, combo: 2 });
    expect(talliesAfterEach(runToFinal(true, false, true)).at(-1)).toEqual({ sparks: 2, combo: 1 });
    expect(talliesAfterEach(runToFinal(false, true, true)).at(-1)).toEqual({ sparks: 2, combo: 2 });
  });

  it('pays a wrong Final call nothing, and never pays a Call it twice', () => {
    expect(talliesAfterEach(runToFinal(true, true, false)).at(-1)).toEqual({ sparks: 2, combo: 0 });
    expect(tallyOf(run(true, true, true, true))).toEqual({ sparks: 4, combo: 4 });
  });

  it('says whether the bonus is waiting from the combo going in, for the screen to announce before the lock', () => {
    expect([0, 1, 2, 3].map(finalBonusReady)).toEqual([false, false, true, true]);
    expect(sparksEarned({ correct: true, finalCall: true }, 1)).toBe(1);
    expect(sparksEarned({ correct: true, finalCall: true }, 2)).toBe(2);
    expect(sparksEarned({ correct: false, finalCall: true }, 3)).toBe(0);
  });

  it('never gives more than five sparks to a Scroll of four calls, so the stored bound holds', () => {
    for (let length = 1; length <= 4; length += 1)
      for (let bits = 0; bits < 2 ** length; bits += 1) {
        const locks = Array.from({ length }, (_, index) => ({
          correct: (bits >> index) % 2 === 1,
          finalCall: index === length - 1,
        }));
        const tally = tallyOf(locks);
        expect(tally.sparks).toBeLessThanOrEqual(5);
        expect(tally.combo).toBeLessThanOrEqual(tally.sparks);
      }
  });
});

describe('the finish of a landmark (D-188)', () => {
  it('is gold for a right Final call and plain for any other', () => {
    expect(landmarkTier(true)).toBe('gold');
    expect(landmarkTier(false)).toBe('plain');
  });
});
