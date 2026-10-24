import { describe, expect, it } from 'vitest';
import { awayAfter, newestSequence } from './away-divider';

const messages = (...sequences: number[]) => sequences.map((sequence) => ({ sequence }));
const nobodyOwn = () => false;

describe('the "While you were away" divider', () => {
  it('follows the newest message confirmed before the connection was lost', () => {
    expect(newestSequence(messages(1, 2, 3))).toBe(3);
    expect(newestSequence([])).toBe(0);
  });

  it('is drawn only when something arrived after that point', () => {
    expect(awayAfter(3, messages(1, 2, 3, 4), nobodyOwn)).toBe(3);
    expect(awayAfter(3, messages(1, 2, 3), nobodyOwn)).toBeUndefined();
  });

  it('is not drawn when no connection was lost', () => {
    expect(awayAfter(undefined, messages(1, 2, 3), nobodyOwn)).toBeUndefined();
  });

  it('does not count the person’s own messages that settled after the reconnect', () => {
    const own = (message: { sequence: number }) => message.sequence === 4;
    expect(awayAfter(3, messages(1, 2, 3, 4), own)).toBeUndefined();
    expect(awayAfter(3, messages(1, 2, 3, 4, 5), own)).toBe(3);
  });
});
