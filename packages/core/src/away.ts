/**
 * ADR-0039 — "While you were away": pure selection over what the database found since the reader's
 * marker. It only orders, caps and counts; it never words anything or decides what counts as away
 * (the queries do: only what the reader did not cause).
 */

export type AwayCandidate = { kind: string; at: string; key: string };

/**
 * Newest first; equal times fall back to kind and key so the order never depends on the queries'
 * own. Anything at or before `since` is dropped (a marker is exclusive). `total` is how many
 * unacknowledged items exist in all, which may exceed the candidates passed when a source was
 * itself capped (each source passes at least `limit + 1`). A list that is not full therefore left
 * nothing out, and says so even if a source counted a row it could not show.
 */
export function selectAway<T extends AwayCandidate>(candidates: readonly T[], since: string | null, limit: number, total: number): { items: T[]; more: number } {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  const after = since === null ? [...candidates] : candidates.filter(c => Date.parse(c.at) > Date.parse(since));
  after.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.kind.localeCompare(b.kind) || a.key.localeCompare(b.key));
  const items = after.slice(0, limit);
  return { items, more: items.length < limit ? 0 : Math.max(0, Math.max(total, after.length) - items.length) };
}

/** The marker a client may set: the newest item it displayed, never behind the current marker. */
export function nextMarker(current: string | null, through: string): string | null {
  if (current !== null && Date.parse(through) <= Date.parse(current)) return null;
  return through;
}
