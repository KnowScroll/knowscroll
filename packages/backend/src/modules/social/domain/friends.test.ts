import { describe, expect, it } from 'vitest';
import { apply, atTime, replayAllowed, REQUEST_WINDOW_MS, sideOf, type Pair } from './friends.js';
const pair = (): Pair => ({
  id: 'private',
  low: 'a',
  high: 'b',
  privateRevision: 0,
  lineage: null,
  window: null,
  sides: [
    { accountId: 'a', blocked: false, revision: 0, state: 'none' },
    { accountId: 'b', blocked: false, revision: 0, state: 'none' },
  ],
});
function act(
  p: Pair,
  actor: string,
  operation: Parameters<typeof apply>[1]['operation'],
  expected: number,
  now = 1,
  requestId?: string,
) {
  const result = apply(p, { actor, operation, expected, ...(requestId ? { requestId } : {}) }, now, 'request');
  if (result.kind !== 'accepted') throw new Error(`CI transition refused: ${result.code}`);
  return result.pair;
}
describe('caller-public Friends views', () => {
  it('silent decline preserves sender revision, identity, cooldown, retry and deadline', () => {
    const ignored = act(pair(), 'a', 'request', 0),
      declined = act(ignored, 'b', 'decline', 1, 2, 'request');
    expect(sideOf(declined, 'a')).toEqual(sideOf(ignored, 'a'));
    for (const now of [3, REQUEST_WINDOW_MS, REQUEST_WINDOW_MS + 1]) {
      expect(sideOf(atTime(declined, now), 'a')).toEqual(sideOf(atTime(ignored, now), 'a'));
      expect(apply(declined, { actor: 'a', operation: 'request', expected: 0 }, now, 'new').kind).toEqual(
        apply(ignored, { actor: 'a', operation: 'request', expected: 0 }, now, 'new').kind,
      );
    }
    expect(sideOf(act(declined, 'a', 'cancel', 1, 3, 'request'), 'a')).toEqual(
      sideOf(act(ignored, 'a', 'cancel', 1, 3, 'request'), 'a'),
    );
    expect(atTime(atTime(declined, REQUEST_WINDOW_MS + 1), REQUEST_WINDOW_MS + 2)).toEqual(
      atTime(declined, REQUEST_WINDOW_MS + 1),
    );
  });
  it('reciprocal request cannot accept; explicit acceptance and remove fence old lineage', () => {
    const pending = act(pair(), 'a', 'request', 0);
    expect(act(pending, 'b', 'request', 1).lineage).toBeNull();
    const accepted = act(pending, 'b', 'accept', 1, 3, 'request');
    expect(accepted.sides.map((s) => s.state)).toEqual(['friends', 'friends']);
    expect(replayAllowed(accepted, 'b', 'accept', 'request', 3)).toBe(true);
    const removed = act(accepted, 'a', 'remove', 2);
    expect(replayAllowed(removed, 'b', 'accept', 'request', 3)).toBe(false);
  });
  it('block stops acceptance, preserves pending sender view and unblock restores nothing', () => {
    const pending = act(pair(), 'a', 'request', 0),
      blocked = act(pending, 'b', 'block', 1);
    expect(sideOf(blocked, 'a')).toEqual(sideOf(pending, 'a'));
    expect(apply(blocked, { actor: 'a', operation: 'accept', expected: 1, requestId: 'request' }, 2, 'other')).toEqual({
      kind: 'refused',
      code: 'unavailable',
    });
    const unblocked = act(blocked, 'b', 'unblock', 2);
    expect(sideOf(unblocked, 'b').state).toBe('none');
    expect(unblocked.lineage).toBeNull();
    expect(
      apply(unblocked, { actor: 'b', operation: 'accept', expected: 3, requestId: 'request' }, 2, 'other'),
    ).toEqual({ kind: 'refused', code: 'unavailable' });
  });
  it('does not mutate input and checks public counter exhaustion', () => {
    const source = pair();
    source.sides[0].revision = Number.MAX_SAFE_INTEGER;
    expect(() => act(source, 'a', 'request', Number.MAX_SAFE_INTEGER)).toThrow('SOCIAL_COUNTER_EXHAUSTED');
    expect(source.window).toBeNull();
  });
});
