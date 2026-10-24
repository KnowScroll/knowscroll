import { describe, expect, it } from 'vitest';
import { changesCursor, historyCursor, inboxCursor } from './cursors.js';

const conversationId = '0199a000-0000-7000-8000-000000000001';
/** The latest time a JavaScript Date can hold, in milliseconds. */
const LATEST_DATE_MS = 8.64e15;

describe('conversation cursors', () => {
  it('round-trip their position and keep one spelling per position', () => {
    const inbox = { activityMs: Date.UTC(2026, 9, 24), conversationId };
    expect(inboxCursor.decode(inboxCursor.encode(inbox))).toEqual(inbox);
    const history = { conversationId, beforeSequence: 41 };
    expect(historyCursor.decode(historyCursor.encode(history))).toEqual(history);
    const changes = { conversationId, afterChangeSequence: 7 };
    expect(changesCursor.decode(changesCursor.encode(changes))).toEqual(changes);
    expect(inboxCursor.decode(`${inboxCursor.encode(inbox)}A`)).toBeUndefined();
  });

  it('refuses another kind of cursor and text that is not a cursor', () => {
    const token = historyCursor.encode({ conversationId, beforeSequence: 3 });
    expect(inboxCursor.decode(token)).toBeUndefined();
    expect(changesCursor.decode(token)).toBeUndefined();
    expect(inboxCursor.decode('kci1_not-a-position-at-all-x')).toBeUndefined();
    expect(inboxCursor.decode('')).toBeUndefined();
  });

  it('refuses an inbox time that is no date, so a forged cursor asks for a fresh start instead of failing', () => {
    expect(inboxCursor.decode(inboxCursor.encode({ activityMs: LATEST_DATE_MS, conversationId }))).toEqual({
      activityMs: LATEST_DATE_MS,
      conversationId,
    });
    for (const activityMs of [LATEST_DATE_MS + 1, Number.MAX_SAFE_INTEGER])
      expect(inboxCursor.decode(inboxCursor.encode({ activityMs, conversationId }))).toBeUndefined();
  });
});
