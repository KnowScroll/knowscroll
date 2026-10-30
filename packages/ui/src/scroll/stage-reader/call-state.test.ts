import type { CallItStop, FinalCallStop } from '@knowscroll/scroll-model';
import { FRESH_CALL, lockIn, pickOption, resultOf } from './call-state';

const source = { label: 'Fixture label', reviewed: true };
const call: CallItStop = {
  kind: 'call_it',
  id: 'call-a',
  prompt: 'Which one?',
  options: ['first', 'second', 'third'],
  answer: 1,
  explain: 'Because second.',
  twist: 'A twist.',
  simple: 'Second.',
  commonGuess: { option: 0, source },
};
const final: FinalCallStop = {
  kind: 'final_call',
  id: 'final-a',
  prompt: 'And now?',
  options: ['first', 'second'],
  answer: 1,
  explain: 'Because.',
  twist: 'A twist.',
  simple: 'Second.',
};

describe('a call played on the device', () => {
  it('picks while open, ignores options it does not have, and does not change a revealed call', () => {
    const picked = pickOption(FRESH_CALL, 2, 3);
    expect(picked.picked).toBe(2);
    expect(pickOption(picked, 3, 3)).toBe(picked);
    expect(pickOption(picked, -1, 3)).toBe(picked);
    const revealed = lockIn(picked);
    expect(pickOption(revealed, 0, 3)).toBe(revealed);
  });

  it('cannot lock in with nothing picked, and a second lock in is no change', () => {
    expect(lockIn(FRESH_CALL)).toBe(FRESH_CALL);
    const revealed = lockIn(pickOption(FRESH_CALL, 1, 3));
    expect(revealed.revealed).toBe(true);
    expect(lockIn(revealed)).toBe(revealed);
  });

  it('shows nothing before the reveal, whatever was picked', () => {
    expect(resultOf(call, pickOption(FRESH_CALL, 1, 3))).toBeUndefined();
  });

  it('says whether it was right and shows the source only for the common guess', () => {
    const lock = (option: number) => lockIn(pickOption(FRESH_CALL, option, 3));
    expect(resultOf(call, lock(1))).toEqual({ correct: true, guessSource: undefined });
    expect(resultOf(call, lock(0))).toEqual({ correct: false, guessSource: 'Fixture label' });
    expect(resultOf(call, lock(2))).toEqual({ correct: false, guessSource: undefined });
    expect(resultOf(final, lock(0))).toEqual({ correct: false, guessSource: undefined });
  });
});
