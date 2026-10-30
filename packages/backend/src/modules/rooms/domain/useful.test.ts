import { describe, expect, it } from 'vitest';
import { usefulRefusal } from './useful.js';

describe('who may mark a message Useful', () => {
  it('allows a message that is shown and was written by someone else', () => {
    expect(usefulRefusal({ shown: true, ownMessage: false })).toBeUndefined();
  });

  it('refuses a member their own message', () => {
    expect(usefulRefusal({ shown: true, ownMessage: true })).toBe('own_message');
  });

  it('refuses a message that is not shown (removed, or a deleted account), before anything else', () => {
    expect(usefulRefusal({ shown: false, ownMessage: false })).toBe('not_shown');
    expect(usefulRefusal({ shown: false, ownMessage: true })).toBe('not_shown');
  });
});
