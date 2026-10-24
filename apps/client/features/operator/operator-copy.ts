/** Why a piece cannot be shown, as the API names it. */
export type OperatorUnavailableReason = 'no_tier0_source' | 'view_missing' | 'read_failed';

/** The words for each reason (D-006 l: a panel with no Tier 0 source says so). */
export const unavailableWords: Readonly<Record<OperatorUnavailableReason, string>> = {
  no_tier0_source: 'no Tier 0 source',
  view_missing: 'the view is not installed',
  read_failed: 'the read failed',
};

/** `10:00:03` of an ISO time, in UTC, which is what the records use. */
export function clockOf(iso: string): string {
  return iso.slice(11, 19);
}

/** `24 Oct 10:00:03` of an ISO time, in UTC. */
export function dayAndClockOf(iso: string): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[Number(iso.slice(5, 7)) - 1] ?? '';
  return `${String(Number(iso.slice(8, 10)))} ${month} ${clockOf(iso)}`;
}

/** A wait in seconds as a short span ("42 s", "7 min", "3 h", "2 d"). */
export function spanOf(seconds: number): string {
  if (seconds < 90) return `${String(seconds)} s`;
  if (seconds < 90 * 60) return `${String(Math.round(seconds / 60))} min`;
  if (seconds < 36 * 3600) return `${String(Math.round(seconds / 3600))} h`;
  return `${String(Math.round(seconds / 86400))} d`;
}

/** The sources an error can come from, and whether its ID opens a journey. */
const JOURNEY_SOURCES: readonly string[] = [
  'model_attempt',
  'production_run',
  'refused_answer',
  'reel_attempt',
  'business_run',
];
export const hasJourney = (source: string): boolean => JOURNEY_SOURCES.includes(source);
