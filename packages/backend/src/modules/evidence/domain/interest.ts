import { ACTIVITY_POLICY } from './activity.js';

/**
 * The key of a stored interest row that orders by decayed activity without reading the time (migration 0121, D-420).
 *
 * Every row decays by the same law, `A_now = A * 2^(-(now - T) / h)`, so `ln A_now = (ln A + ln2 * T / h) - ln2 * now / h`. The part
 * in brackets does not depend on `now`: ordering rows by it is ordering them by decayed activity at any later time, and the
 * rows above a decayed-activity floor are the rows above a fixed key. "The person's top K topics now" is therefore one range scan
 * of an index, however many topics the person has met. `null` while the activity is 0 (`ln 0`): such a row has no place in the
 * index. The half life is the one `activity.v1` decays with.
 */
export function logWeightOf(activityValue: number, evaluatedAtMs: number): number | null {
  if (!Number.isFinite(activityValue) || activityValue < 0 || !Number.isFinite(evaluatedAtMs))
    throw new Error('INTEREST_LOG_WEIGHT_INVALID');
  return activityValue > 0 ? Math.log(activityValue) + (Math.LN2 * evaluatedAtMs) / ACTIVITY_POLICY.halfLifeMs : null;
}

/**
 * The least `log_weight` a row may have to hold at least `floor` of decayed activity at `nowMs`: the lower bound of the
 * top-interest scan. A floor of 0 or less has no bound.
 */
export function logWeightFloor(floor: number, nowMs: number): number | null {
  return floor > 0 ? logWeightOf(floor, nowMs) : null;
}

/** An activity read at `nowMs` from a row stored at `storedAtMs`; a row stored after `nowMs` (clock skew) is not grown. */
export function decayedActivity(stored: number, storedAtMs: number, nowMs: number): number {
  return stored * Math.pow(2, -Math.max(0, nowMs - storedAtMs) / ACTIVITY_POLICY.halfLifeMs);
}
