/**
 * ADR-0039 — "While you were away": pure selection over what the database found since the reader's
 * marker. It only orders, caps and counts; it never words anything or decides what counts as away
 * (the queries do: only what the reader did not cause).
 */
import { AWAY_CURSOR_PATTERN, type AWAY_KINDS } from '../../contracts/src/away.ts';

export type AwayCandidate = { kind: string; at: string; key: string };

/** Byte-wise, as SQL compares under `COLLATE "C"`, so a page ends where the queries' order ends. */
const bytewise = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The list's one total order (ADR-0044 M7): newest first by the wire's millisecond, then kind, then
 * key. The queries order the same way, so a page cursor neither repeats nor skips an item.
 */
export function compareAway(a: AwayCandidate, b: AwayCandidate): number {
  return Date.parse(b.at) - Date.parse(a.at) || bytewise(a.kind, b.kind) || bytewise(a.key, b.key);
}

/** The cursor of a page's last item: the next page is everything after it in [compareAway]'s order. */
export function awayCursor(item: AwayCandidate): string {
  return `${item.at}|${item.kind}|${item.key}`;
}

export function parseAwayCursor(cursor: string): { at: string; kind: (typeof AWAY_KINDS)[number]; key: string } | null {
  const m = AWAY_CURSOR_PATTERN.exec(cursor);
  return m ? { at: m[1]!, kind: m[2] as (typeof AWAY_KINDS)[number], key: m[3]! } : null;
}

/**
 * Newest first, in [compareAway]'s order. Anything at or before `since` is dropped (a marker is
 * exclusive). `total` is how many unacknowledged items exist in all (from the page's start on),
 * which may exceed the candidates passed when a source was itself capped (each source passes at
 * least `limit + 1`). A list that is not full therefore left nothing out, and says so even if a
 * source counted a row it could not show.
 */
export function selectAway<T extends AwayCandidate>(candidates: readonly T[], since: string | null, limit: number, total: number): { items: T[]; more: number } {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const after = since === null ? [...candidates] : candidates.filter(c => Date.parse(c.at) > Date.parse(since));
  after.sort(compareAway);
  const items = after.slice(0, limit);
  return { items, more: items.length < limit ? 0 : Math.max(0, Math.max(total, after.length) - items.length) };
}

/** The marker a client may set: the newest item it displayed, never behind the current marker. */
export function nextMarker(current: string | null, through: string): string | null {
  if (current !== null && Date.parse(through) <= Date.parse(current)) return null;
  return through;
}

/** The wire's bound on a chronicle line (`contracts/away.ts`). A foundation that holds up many places
 * can word a longer one (ADR-0037): it is shortened at a word with an ellipsis, never dropped, so one
 * long line can never make the whole list unreadable to a strict client. */
export const AWAY_LINE_MAX = 600;

export function clampLine(line: string, max = AWAY_LINE_MAX): string {
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const atWord = cut.lastIndexOf(' ');
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).trimEnd()}…`;
}
