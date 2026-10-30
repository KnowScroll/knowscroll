import { describe, expect, it } from 'vitest';
import { talliesAfterEach } from '@knowscroll/scroll-model';
import { NO_PLAY, afterLock, judgePick } from './results.js';

describe('judging a pick', () => {
  const call = { optionCount: 3, answer: 1 };

  it("is right only for the call's answer", () => {
    expect(judgePick(call, 1)).toEqual({ kind: 'judged', correct: true });
    expect(judgePick(call, 0)).toEqual({ kind: 'judged', correct: false });
    expect(judgePick(call, 2)).toEqual({ kind: 'judged', correct: false });
  });

  it('refuses an option the call does not have rather than calling it wrong', () => {
    for (const forged of [3, 4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(judgePick(call, forged)).toEqual({ kind: 'option_out_of_range' });
    expect(judgePick({ optionCount: 2, answer: 0 }, 2)).toEqual({ kind: 'option_out_of_range' });
  });
});

describe('what a lock adds', () => {
  it('earns a spark and builds the combo for each right call in a row', () => {
    const first = afterLock(NO_PLAY, true);
    const second = afterLock(first, true);
    expect(first).toEqual({ callsLocked: 1, sparks: 1, combo: 1 });
    expect(second).toEqual({ callsLocked: 2, sparks: 2, combo: 2 });
  });

  it('keeps the sparks and ends the combo on a wrong call, without any penalty', () => {
    const twoRight = afterLock(afterLock(NO_PLAY, true), true);
    expect(afterLock(twoRight, false)).toEqual({ callsLocked: 3, sparks: 2, combo: 0 });
    expect(afterLock(NO_PLAY, false)).toEqual({ callsLocked: 1, sparks: 0, combo: 0 });
  });

  it('starts the combo again after a wrong call', () => {
    const afterWrong = afterLock(afterLock(NO_PLAY, true), false);
    expect(afterLock(afterWrong, true)).toEqual({ callsLocked: 3, sparks: 2, combo: 1 });
  });
});

describe("the device's tally and the server's", () => {
  it('agree after every lock of every run of up to six right and wrong calls', () => {
    for (let length = 0; length <= 6; length += 1)
      for (let bits = 0; bits < 2 ** length; bits += 1) {
        const run = Array.from({ length }, (_, index) => ({ correct: (bits >> index) % 2 === 1 }));
        let tally = NO_PLAY;
        const server = run.map((lock) => {
          tally = afterLock(tally, lock.correct);
          return { sparks: tally.sparks, combo: tally.combo };
        });
        expect(talliesAfterEach(run)).toEqual(server);
      }
  });
});
