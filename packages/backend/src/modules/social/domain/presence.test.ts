import { describe, expect, it } from 'vitest';
import { PRESENCE_HEARTBEAT_MS } from '@knowscroll/contracts';
import { PRESENCE, availabilityOf } from './presence.js';

const now = Date.parse('2026-10-24T09:00:00Z');
const seen = (agoMs: number, windowNumber = 3) => ({ lastSeenAtMs: now - agoMs, windowNumber });

describe('availability of a friend', () => {
  it('lets three missed heartbeats end "Online"', () => {
    expect(PRESENCE.onlineMs).toBeGreaterThanOrEqual(3 * PRESENCE_HEARTBEAT_MS);
  });

  it('shows what the person chose while their heartbeat is fresh', () => {
    expect(availabilityOf('online', seen(5_000), now)).toEqual({
      state: 'online',
      expiryRevision: 3,
      validForMs: PRESENCE.onlineLeaseMs,
    });
    expect(availabilityOf('recently_active', seen(5_000), now)).toMatchObject({ state: 'recently_active' });
  });

  it('never shows more than the person chose, however recent the heartbeat', () => {
    expect(availabilityOf('recently_active', seen(0), now).state).not.toBe('online');
  });

  it('moves from online to recently active and then to unknown as the heartbeat ages', () => {
    expect(availabilityOf('online', seen(PRESENCE.onlineMs - 1), now).state).toBe('online');
    expect(availabilityOf('online', seen(PRESENCE.onlineMs), now).state).toBe('recently_active');
    expect(availabilityOf('online', seen(PRESENCE.recentMs - 1), now).state).toBe('recently_active');
    expect(availabilityOf('online', seen(PRESENCE.recentMs), now)).toEqual({ state: 'unknown' });
  });

  it('gives hidden, expired and never-seen exactly the same answer', () => {
    const hidden = availabilityOf('hidden', seen(1_000), now);
    const expired = availabilityOf('online', seen(PRESENCE.recentMs + 1), now);
    const never = availabilityOf('online', undefined, now);
    expect(hidden).toEqual({ state: 'unknown' });
    expect(JSON.stringify(expired)).toBe(JSON.stringify(hidden));
    expect(JSON.stringify(never)).toBe(JSON.stringify(hidden));
  });

  it('never carries the time left, so the last heartbeat cannot be worked out', () => {
    const early = availabilityOf('online', seen(1_000), now);
    const late = availabilityOf('online', seen(PRESENCE.onlineMs - 1_000), now);
    expect(early).toEqual(late);
    const recentEarly = availabilityOf('online', seen(PRESENCE.onlineMs + 1_000), now);
    const recentLate = availabilityOf('online', seen(PRESENCE.recentMs - 1_000), now);
    expect(recentEarly).toEqual(recentLate);
  });

  it('treats a heartbeat from the future as just now', () => {
    expect(availabilityOf('online', { lastSeenAtMs: now + 600_000, windowNumber: 1 }, now).state).toBe('online');
  });
});
