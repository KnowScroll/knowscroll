import { describe, expect, it } from 'vitest';
import { awayAfter, newestSequence, newSinceAfter } from './away-divider';

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

describe('the "New since you were here" line', () => {
  it('follows the position the person had read through when they opened it', () => {
    expect(newSinceAfter(2, messages(1, 2, 3, 4), nobodyOwn)).toBe(2);
  });

  it('is not drawn when nothing came after that position', () => {
    expect(newSinceAfter(3, messages(1, 2, 3), nobodyOwn)).toBeUndefined();
  });

  it('is not drawn for a place the person never read in: everything would be new', () => {
    expect(newSinceAfter(0, messages(1, 2, 3), nobodyOwn)).toBeUndefined();
  });

  it('does not count the person’s own messages', () => {
    const own = (message: { sequence: number }) => message.sequence === 4;
    expect(newSinceAfter(3, messages(1, 2, 3, 4), own)).toBeUndefined();
    expect(newSinceAfter(3, messages(1, 2, 3, 4, 5), own)).toBe(3);
  });

  it('follows the person’s own last message when they wrote here but never read: writing somewhere is being there (#648)', () => {
    const own = (message: { sequence: number }) => message.sequence === 2;
    // Wrote message 2 without opening the place (a share sheet), so the read position never moved off 0.
    expect(newSinceAfter(0, messages(1, 2, 3, 4), own)).toBe(2);
    // A read position that exists still governs.
    expect(newSinceAfter(1, messages(1, 2, 3, 4), own)).toBe(1);
    // Nothing from anyone else came after the person's own message.
    expect(newSinceAfter(0, messages(1, 2), own)).toBeUndefined();
  });
});
