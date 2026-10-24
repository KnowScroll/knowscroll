import { describe, expect, it } from 'vitest';
import { PRESENCE_HEARTBEAT_MS } from '@knowscroll/contracts';
import { PRESENCE, availabilityOf } from './presence.js';

const seen = (ageMs: number, windowToken = 3_141_592_653) => ({ ageMs, windowToken });

describe('availability of a friend', () => {
  it('lets three missed heartbeats end "Online"', () => {
    expect(PRESENCE.onlineMs).toBeGreaterThanOrEqual(3 * PRESENCE_HEARTBEAT_MS);
  });

  it('shows what the person chose while their heartbeat is fresh', () => {
    expect(availabilityOf('online', seen(5_000))).toEqual({
      state: 'online',
      expiryRevision: 3_141_592_653,
      validForMs: PRESENCE.onlineLeaseMs,
    });
    expect(availabilityOf('recently_active', seen(5_000))).toMatchObject({ state: 'recently_active' });
  });

  it('never shows more than the person chose, however recent the heartbeat', () => {
    expect(availabilityOf('recently_active', seen(0)).state).not.toBe('online');
  });

  it('moves from online to recently active and then to unknown as the heartbeat ages', () => {
    expect(availabilityOf('online', seen(PRESENCE.onlineMs - 1)).state).toBe('online');
    expect(availabilityOf('online', seen(PRESENCE.onlineMs)).state).toBe('recently_active');
    expect(availabilityOf('online', seen(PRESENCE.recentMs - 1)).state).toBe('recently_active');
    expect(availabilityOf('online', seen(PRESENCE.recentMs))).toEqual({ state: 'unknown' });
  });

  it('gives hidden, expired and never-seen exactly the same answer', () => {
    const hidden = availabilityOf('hidden', seen(1_000));
    const expired = availabilityOf('online', seen(PRESENCE.recentMs + 1));
    const never = availabilityOf('online', undefined);
    expect(hidden).toEqual({ state: 'unknown' });
    expect(JSON.stringify(expired)).toBe(JSON.stringify(hidden));
    expect(JSON.stringify(never)).toBe(JSON.stringify(hidden));
  });

  it('never carries the time left, so the last heartbeat cannot be worked out', () => {
    const early = availabilityOf('online', seen(1_000));
    const late = availabilityOf('online', seen(PRESENCE.onlineMs - 1_000));
    expect(early).toEqual(late);
    const recentEarly = availabilityOf('online', seen(PRESENCE.onlineMs + 1_000));
    const recentLate = availabilityOf('online', seen(PRESENCE.recentMs - 1_000));
    expect(recentEarly).toEqual(recentLate);
  });

  it('treats a negative age (a clock that stepped back) as just now', () => {
    expect(availabilityOf('online', seen(-600_000)).state).toBe('online');
  });

  it('carries the window token as given and nothing that counts', () => {
    expect(availabilityOf('online', seen(1_000, 17))).toMatchObject({ expiryRevision: 17 });
    expect(availabilityOf('online', seen(1_000, 9_007_199_254_740_990))).toMatchObject({
      expiryRevision: 9_007_199_254_740_990,
    });
  });
});
