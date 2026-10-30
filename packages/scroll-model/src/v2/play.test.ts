import { describe, expect, it } from 'vitest';
import { NO_TALLY, talliesAfterEach, tallyOf } from './play.js';

const run = (...correct: boolean[]) => correct.map((value) => ({ correct: value }));

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
