/**
 * Pure rules the thread screens share for snippets (blueprint §17): how a Reel range is nudged and
 * written, and how a Scroll paragraph is cut into passages a person can pick. No React, no network.
 * The server is the authority on every anchor; these only help a person build one that will hold.
 */

/** The shortest Reel moment that can be shared; the server enforces the same floor. */
export const MIN_RANGE_MS = 1_000;
/** The most text a passage can hold, in UTF-16 code units (scroll-model's `LIMITS.passageChars`). */
export const MAX_PASSAGE_CHARS = 600;

/** "0:18" or, from an hour, "1:02:03". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${seconds}` : `${String(minutes)}:${seconds}`;
}

/** "0:18–0:31". */
export const formatRange = (startMs: number, endMs: number): string => `${formatClock(startMs)}–${formatClock(endMs)}`;

export interface ReelRange {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * A range that starts where the person is and runs `lengthMs` on, kept inside the Reel and never
 * shorter than the floor (a Reel too short for the floor gives the whole Reel).
 */
export function initialRange(positionMs: number, durationMs: number, lengthMs = 10_000): ReelRange {
  const startMs = Math.min(Math.max(0, Math.floor(positionMs / 1000) * 1000), Math.max(0, durationMs - MIN_RANGE_MS));
  return { startMs, endMs: Math.min(durationMs, startMs + Math.max(lengthMs, MIN_RANGE_MS)) };
}

/**
 * Moves one end of a range by `deltaMs`, keeping the range inside `[0, durationMs]` and at least
 * the floor long: an end that would cross the other stops one floor away from it.
 */
export function nudgeRange(range: ReelRange, end: 'start' | 'end', deltaMs: number, durationMs: number): ReelRange {
  if (end === 'start') {
    const startMs = Math.min(Math.max(0, range.startMs + deltaMs), range.endMs - MIN_RANGE_MS);
    return { startMs: Math.max(0, startMs), endMs: range.endMs };
  }
  const endMs = Math.max(Math.min(durationMs, range.endMs + deltaMs), range.startMs + MIN_RANGE_MS);
  return { startMs: range.startMs, endMs: Math.min(durationMs, endMs) };
}

/** Sets one end to a moment the person chose (the player's position), under the same rules. */
export function setRangeEnd(range: ReelRange, end: 'start' | 'end', atMs: number, durationMs: number): ReelRange {
  const at = Math.floor(atMs / 1000) * 1000;
  return nudgeRange(range, end, at - (end === 'start' ? range.startMs : range.endMs), durationMs);
}

export interface PassageRange {
  /** UTF-16 offsets `[start, end)` into the text. */
  readonly start: number;
  readonly end: number;
}

/**
 * Cuts a paragraph's text into sentences, as offsets. A sentence ends at `.`, `!`, `?` or `…`
 * (with any closing quote or bracket) followed by a space or the end. Every cut falls between a
 * punctuation mark and whitespace, so it is never inside a character. A sentence longer than a
 * passage can be is cut at the last space before the limit. Leading spaces are not part of a sentence.
 */
export function sentenceRanges(text: string, limit = MAX_PASSAGE_CHARS): PassageRange[] {
  const ranges: PassageRange[] = [];
  const push = (from: number, to: number) => {
    let start = from;
    while (start < to && /\s/.test(text[start] ?? '')) start++;
    let end = to;
    while (end > start && /\s/.test(text[end - 1] ?? '')) end--;
    while (end - start > limit) {
      const cut = text.lastIndexOf(' ', start + limit);
      const at = cut > start ? cut : start + limit;
      ranges.push({ start, end: at });
      start = at;
      while (start < end && /\s/.test(text[start] ?? '')) start++;
    }
    if (end > start) ranges.push({ start, end });
  };
  const sentenceEnd = /[.!?…]+["'”’)\]]*(?=\s|$)/g;
  let from = 0;
  for (const match of text.matchAll(sentenceEnd)) {
    push(from, match.index + match[0].length);
    from = match.index + match[0].length;
  }
  push(from, text.length);
  return ranges;
}

/**
 * The passage a person picked: from the first to the last chosen sentence, as one range. A choice
 * that would pass the limit shrinks from the far end until it fits.
 */
export function passageOf(
  sentences: readonly PassageRange[],
  first: number,
  last: number,
  limit = MAX_PASSAGE_CHARS,
): PassageRange | undefined {
  const from = sentences[Math.min(first, last)];
  if (from === undefined) return undefined;
  for (let index = Math.max(first, last); index >= Math.min(first, last); index--) {
    const to = sentences[index];
    if (to !== undefined && to.end - from.start <= limit) return { start: from.start, end: to.end };
  }
  return undefined;
}
