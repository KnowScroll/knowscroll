/**
 * The weekly Orbit (D-087, D-215): how many days of this week a person played, out of three. Pure
 * calendar arithmetic on `YYYY-MM-DD` day names already placed in the person's time zone; the clock
 * and the zone belong to the store, so this file holds no time source.
 *
 * It is a count for the week, never a streak. Nothing here looks at an earlier week, so a missed
 * week removes nothing, and nothing the person owns depends on it (D-064).
 */

/** Days of a week that close the Orbit. The contract's `ORBIT_DAYS_TO_CLOSE` is the same number. */
export const ORBIT_DAYS_TO_CLOSE = 3;

/** The Orbit of one week. */
export interface WeekOrbit {
  readonly days: number;
  readonly goal: typeof ORBIT_DAYS_TO_CLOSE;
  readonly weekStart: string;
  readonly closed: boolean;
}

const DAY_MS = 86_400_000;

function dayNumber(day: string): number {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, date) / DAY_MS;
}

function dayName(number: number): string {
  return new Date(number * DAY_MS).toISOString().slice(0, 10);
}

/** The Monday on or before `day` (ISO weeks begin on Monday). */
export function weekStartOf(day: string): string {
  const number = dayNumber(day);
  // 1970-01-01 was a Thursday, so day number 0 has weekday 4 (Monday = 1).
  const weekday = (((number + 3) % 7) + 7) % 7;
  return dayName(number - weekday);
}

/**
 * The Orbit of the week that contains `today`: the distinct days among `playedDays` from that
 * week's Monday to `today`. Days outside the week, and repeats, are ignored.
 */
export function orbitOf(playedDays: readonly string[], today: string): WeekOrbit {
  const weekStart = weekStartOf(today);
  const first = dayNumber(weekStart);
  const last = dayNumber(today);
  const inWeek = new Set(playedDays.filter((day) => dayNumber(day) >= first && dayNumber(day) <= last));
  return {
    days: inWeek.size,
    goal: ORBIT_DAYS_TO_CLOSE,
    weekStart,
    closed: inWeek.size >= ORBIT_DAYS_TO_CLOSE,
  };
}
