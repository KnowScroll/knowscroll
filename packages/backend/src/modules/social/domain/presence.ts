/**
 * Availability words and when they lapse (blueprint §17, D-027, D-047). Pure rules: the adapter
 * stores one heartbeat time per person who chose to show availability, and these functions decide
 * what a friend may be told.
 */
export type PresencePreference = 'online' | 'recently_active' | 'hidden';

/**
 * What a friend is told. `unknown` is the only answer for a hidden preference, an expired
 * heartbeat, no heartbeat and a person who is not a friend: one shape, so none of them can be told
 * apart on the wire.
 */
export type Availability =
  | { readonly state: 'unknown' }
  | {
      readonly state: 'online' | 'recently_active';
      readonly expiryRevision: number;
      readonly validForMs: number;
    };

export const PRESENCE = {
  /** Heartbeats come every 20 s; three missed ones end "Online". */
  onlineMs: 60_000,
  /** After the last heartbeat, a person who shows availability stays "Recently active" this long. */
  recentMs: 15 * 60_000,
  /**
   * The freshness lease each answer carries. It is a constant for the state, never the time that is
   * left, because the time left would give a friend the exact moment of the last heartbeat.
   */
  onlineLeaseMs: 30_000,
  recentLeaseMs: 60_000,
} as const;

/** The stored facts about one person's last heartbeat. Never sent to a friend. */
export interface PresenceRecord {
  readonly lastSeenAtMs: number;
  /** Counts stretches of activity; the `expiryRevision` of an answer. */
  readonly windowNumber: number;
}

/**
 * Availability of one person for a friend at `nowMs`.
 *
 * The preference caps what is shown: someone who chose "Recently active" is never shown as
 * "Online", even while they are. A record from the future (clock skew) counts as just now.
 */
export function availabilityOf(
  preference: PresencePreference,
  record: PresenceRecord | undefined,
  nowMs: number,
): Availability {
  if (preference === 'hidden' || record === undefined) return { state: 'unknown' };
  const ageMs = Math.max(0, nowMs - record.lastSeenAtMs);
  if (ageMs < PRESENCE.onlineMs)
    return preference === 'online'
      ? { state: 'online', expiryRevision: record.windowNumber, validForMs: PRESENCE.onlineLeaseMs }
      : { state: 'recently_active', expiryRevision: record.windowNumber, validForMs: PRESENCE.recentLeaseMs };
  if (ageMs < PRESENCE.recentMs)
    return { state: 'recently_active', expiryRevision: record.windowNumber, validForMs: PRESENCE.recentLeaseMs };
  return { state: 'unknown' };
}
