import { describe, expect, it } from 'vitest';
import { acceptedReadThrough, shareState, visiblePeerRead, SHARE_LIFETIME_MS } from './conversations.js';
import { changesCursor, historyCursor, inboxCursor } from './cursors.js';

const conversationId = '0199a000-0000-7000-8000-000000000001';

describe('share link state', () => {
  const created = new Date('2026-10-24T00:00:00Z');
  const expiresAt = new Date(created.getTime() + SHARE_LIFETIME_MS);
  it('is live until the deadline, then expired', () => {
    expect(shareState({ expiresAt, revokedAt: null }, created)).toBe('live');
    expect(shareState({ expiresAt, revokedAt: null }, new Date(expiresAt.getTime() - 1))).toBe('live');
    expect(shareState({ expiresAt, revokedAt: null }, expiresAt)).toBe('expired');
  });
  it('reads as revoked even after the deadline', () => {
    expect(shareState({ expiresAt, revokedAt: created }, created)).toBe('revoked');
    expect(shareState({ expiresAt, revokedAt: created }, new Date(expiresAt.getTime() + 1))).toBe('revoked');
  });
});

describe('read position', () => {
  it('never moves back and never passes the newest message', () => {
    expect(acceptedReadThrough(3, 5, 9)).toBe(5);
    expect(acceptedReadThrough(7, 5, 9)).toBe(7);
    expect(acceptedReadThrough(3, 9, 9)).toBe(9);
    expect(acceptedReadThrough(3, 10, 9)).toBeUndefined();
  });
});

describe('SEEN is mutual', () => {
  const both = { readerShares: true, peerShares: true, standing: true, peerReadThrough: 4 };
  it('tells the reader how far the other person has read only while both people share', () => {
    expect(visiblePeerRead(both)).toBe(4);
    expect(visiblePeerRead({ ...both, peerReadThrough: 0 })).toBe(0);
  });
  it('is hidden from a reader who hides their own, and when the other person hides theirs', () => {
    expect(visiblePeerRead({ ...both, readerShares: false })).toBeUndefined();
    expect(visiblePeerRead({ ...both, peerShares: false })).toBeUndefined();
    expect(visiblePeerRead({ ...both, readerShares: false, peerShares: false })).toBeUndefined();
  });
  it('is hidden once the conversation has ended', () => {
    expect(visiblePeerRead({ ...both, standing: false })).toBeUndefined();
  });
});

describe('keyset cursors', () => {
  it('round-trip each position under its own prefix', () => {
    const inbox = inboxCursor.encode({ activityMs: 1_761_264_000_123, conversationId });
    expect(inbox).toMatch(/^kci1_[A-Za-z0-9_-]{34}$/);
    expect(inboxCursor.decode(inbox)).toEqual({ activityMs: 1_761_264_000_123, conversationId });
    const history = historyCursor.encode({ conversationId, beforeSequence: 41 });
    expect(historyCursor.decode(history)).toEqual({ conversationId, beforeSequence: 41 });
    const changes = changesCursor.encode({ conversationId, afterChangeSequence: 77 });
    expect(changesCursor.decode(changes)).toEqual({ conversationId, afterChangeSequence: 77 });
  });
  it('refuse another purpose, a truncated token and a non-canonical spelling', () => {
    const history = historyCursor.encode({ conversationId, beforeSequence: 41 });
    expect(changesCursor.decode(history)).toBeUndefined();
    expect(historyCursor.decode(history.slice(0, -2))).toBeUndefined();
    expect(historyCursor.decode(`${history}A`)).toBeUndefined();
    expect(historyCursor.decode('kch1_')).toBeUndefined();
  });
});
