import { describe, expect, it } from 'vitest';
import { changesCursor, historyCursor } from './cursors.js';

const discussionId = '0192a7c0-1f2e-7a3b-8c4d-5e6f708192a3';

describe('discussion cursors', () => {
  it('round-trip a position and give one position one spelling', () => {
    const history = historyCursor.encode({ discussionId, beforeSequence: 41 });
    expect(history).toMatch(/^krh1_[A-Za-z0-9_-]{22,}$/);
    expect(historyCursor.decode(history)).toEqual({ discussionId, beforeSequence: 41 });
    expect(historyCursor.encode({ discussionId, beforeSequence: 41 })).toBe(history);
    const changes = changesCursor.encode({ discussionId, afterChangeSequence: 9 });
    expect(changes).toMatch(/^krc1_/);
    expect(changesCursor.decode(changes)).toEqual({ discussionId, afterChangeSequence: 9 });
  });

  it('refuse another kind of cursor, a damaged one and a non-canonical spelling', () => {
    const history = historyCursor.encode({ discussionId, beforeSequence: 1 });
    expect(changesCursor.decode(history)).toBeUndefined();
    expect(historyCursor.decode(history.slice(0, -2))).toBeUndefined();
    expect(historyCursor.decode(`${history}=`)).toBeUndefined();
    expect(historyCursor.decode('krh1_')).toBeUndefined();
    expect(historyCursor.decode('nonsense')).toBeUndefined();
  });
});
