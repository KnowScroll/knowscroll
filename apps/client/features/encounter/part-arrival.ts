import type { PartArrival } from '@knowscroll/ui';
import type { EncounterEntry } from './encounter-history';

type ScrollEntry = Extract<EncounterEntry, { kind: 'scroll' }>;

/** The entries whose arrival has been said: it is said once per step forward, however often the entry is drawn again. */
const said = new WeakSet<EncounterEntry>();

/**
 * Whether this Scroll was opened by a move forward in its series: the Scroll before it in the trail is the same
 * series' earlier Part. Only then does the reader say "Part 2 · your place in Part 1 is kept" (V3 G2), which is
 * true because that entry is kept in the trail with its place (Back, and the tab, return to it).
 */
export function partArrival(trail: readonly EncounterEntry[], entry: ScrollEntry): PartArrival | undefined {
  const before = trail.at(-2);
  const now = entry.context.series;
  const left = before?.context.series;
  if (trail.at(-1) !== entry || entry.offer.relation.kind !== 'series_step') return undefined;
  if (before?.kind !== 'scroll' || now === undefined || left === undefined) return undefined;
  if (now.seriesId !== left.seriesId || now.part <= left.part) return undefined;
  return { part: `Part ${String(now.part)}`, from: `Part ${String(left.part)}` };
}

/**
 * The arrival to say for an entry that is drawn now: `partArrival`, but only the first time. Coming back to the entry
 * (Back from the next Part, a tab return, an Undo) is not a step forward, so it neither slides in nor says it again.
 * Call `markArrivalSaid` once the reader has been given it.
 */
export function arrivalToSay(trail: readonly EncounterEntry[], entry: ScrollEntry): PartArrival | undefined {
  return said.has(entry) ? undefined : partArrival(trail, entry);
}

/** Notes that the reader of this entry was given its arrival. */
export function markArrivalSaid(entry: EncounterEntry): void {
  said.add(entry);
}
