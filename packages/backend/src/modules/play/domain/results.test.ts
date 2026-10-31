import { describe, expect, it } from 'vitest';
import { landmarkTier, talliesAfterEach } from '@knowscroll/scroll-model';
import { NO_PLAY, afterLock, judgePick, landmarkTierOf, type Tally } from './results.js';

const call = (correct: boolean) => ({ correct, finalCall: false });
const final = (correct: boolean) => ({ correct, finalCall: true });

describe('judging a pick', () => {
  const asked = { optionCount: 3, answer: 1 };

  it("is right only for the call's answer", () => {
    expect(judgePick(asked, 1)).toEqual({ kind: 'judged', correct: true });
    expect(judgePick(asked, 0)).toEqual({ kind: 'judged', correct: false });
    expect(judgePick(asked, 2)).toEqual({ kind: 'judged', correct: false });
  });

  it('refuses an option the call does not have rather than calling it wrong', () => {
    for (const forged of [3, 4, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(judgePick(asked, forged)).toEqual({ kind: 'option_out_of_range' });
    expect(judgePick({ optionCount: 2, answer: 0 }, 2)).toEqual({ kind: 'option_out_of_range' });
  });
});

describe('what a lock adds', () => {
  it('earns a spark and builds the combo for each right call in a row', () => {
    const first = afterLock(NO_PLAY, call(true));
    const second = afterLock(first, call(true));
    expect(first).toEqual({ callsLocked: 1, sparks: 1, combo: 1 });
    expect(second).toEqual({ callsLocked: 2, sparks: 2, combo: 2 });
  });

  it('keeps the sparks and ends the combo on a wrong call, without any penalty', () => {
    const twoRight = afterLock(afterLock(NO_PLAY, call(true)), call(true));
    expect(afterLock(twoRight, call(false))).toEqual({ callsLocked: 3, sparks: 2, combo: 0 });
    expect(afterLock(NO_PLAY, call(false))).toEqual({ callsLocked: 1, sparks: 0, combo: 0 });
  });

  it('starts the combo again after a wrong call', () => {
    const afterWrong = afterLock(afterLock(NO_PLAY, call(true)), call(false));
    expect(afterLock(afterWrong, call(true))).toEqual({ callsLocked: 3, sparks: 2, combo: 1 });
  });
});

describe('the Final call and the combo bonus (D-187)', () => {
  const lockedAll = (...locks: { correct: boolean; finalCall: boolean }[]): Tally =>
    locks.reduce<Tally>((tally, lock) => afterLock(tally, lock), NO_PLAY);

  it('earns one spark when it is right and no combo of two is waiting', () => {
    expect(lockedAll(final(true))).toEqual({ callsLocked: 1, sparks: 1, combo: 1 });
    expect(lockedAll(call(true), final(true))).toEqual({ callsLocked: 2, sparks: 2, combo: 2 });
    expect(lockedAll(call(true), call(false), final(true))).toEqual({ callsLocked: 3, sparks: 2, combo: 1 });
  });

  it('earns two sparks when it is right after a combo of two or more', () => {
    expect(lockedAll(call(true), call(true), final(true))).toEqual({ callsLocked: 3, sparks: 4, combo: 3 });
    expect(lockedAll(call(true), call(true), call(true), final(true))).toEqual({
      callsLocked: 4,
      sparks: 5,
      combo: 4,
    });
  });

  it('earns nothing, and ends the combo, when it is wrong, even with a combo waiting', () => {
    expect(lockedAll(call(true), call(true), final(false))).toEqual({ callsLocked: 3, sparks: 2, combo: 0 });
  });

  it('never pays a call that is not the Final call twice, whatever the combo', () => {
    expect(lockedAll(call(true), call(true), call(true))).toEqual({ callsLocked: 3, sparks: 3, combo: 3 });
  });
});

describe('the finish of a landmark (D-188)', () => {
  it('is gold for a right Final call and plain for a wrong one', () => {
    expect(landmarkTierOf(final(true))).toBe('gold');
    expect(landmarkTierOf(final(false))).toBe('plain');
  });
});

describe("the device's tally and the server's", () => {
  it('agree on the finish of a landmark', () => {
    for (const correct of [true, false]) expect(landmarkTierOf(final(correct))).toBe(landmarkTier(correct));
  });

  it('agree after every lock of every run of up to six right and wrong calls, whichever one is the Final call', () => {
    for (let length = 0; length <= 6; length += 1)
      for (let bits = 0; bits < 2 ** length; bits += 1)
        for (let finalAt = -1; finalAt < length; finalAt += 1) {
          const run = Array.from({ length }, (_, index) => ({
            correct: (bits >> index) % 2 === 1,
            finalCall: index === finalAt,
          }));
          let tally = NO_PLAY;
          const server = run.map((lock) => {
            tally = afterLock(tally, lock);
            return { sparks: tally.sparks, combo: tally.combo };
          });
          expect(talliesAfterEach(run)).toEqual(server);
        }
  });
});
