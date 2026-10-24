import { formatClock, type IconName } from '@knowscroll/ui';
import type { EncounterEntry } from './encounter-history';

/** What an encounter says about where it was opened from, and what Back will do (E06, U04). */
export interface EncounterOrigin {
  /** "From the Reel at 0:31". */
  readonly from: string;
  /** "Back to Reel". Pressing it is Back: nothing is lost or recorded by it. */
  readonly backLabel: string;
  /** The glyph before the words; a parked Reel by default. */
  readonly icon?: IconName;
  /** `paper`: a cream pill with an ink edge (a place on the map); the default is the ink pill of E06. */
  readonly tone?: 'ink' | 'paper';
}

/**
 * E06: a Scroll opened from a Reel's format switch carries "From the Reel at 0:31 · Back to Reel".
 * Only a real switch counts: the entry's offer says it is a format variant, and the entry before it
 * in the trail is the other format of the same explanation. The playhead is the one the Reel was
 * parked at, never invented; a Reel parked before it played says only "From the Reel".
 */
export function formatSwitchOrigin(
  trail: readonly EncounterEntry[],
  entry: EncounterEntry,
): EncounterOrigin | undefined {
  if (entry.offer.relation.kind !== 'format_variant') return undefined;
  const previous = trail.at(-2);
  if (
    previous === undefined ||
    trail.at(-1) !== entry ||
    previous.kind === entry.kind ||
    previous.offer.explanationUnitId !== entry.offer.explanationUnitId
  )
    return undefined;
  const word = previous.kind === 'reel' ? 'Reel' : 'Scroll';
  const place =
    previous.position?.kind === 'reel' && previous.position.positionMs >= 1000
      ? ` at ${formatClock(previous.position.positionMs)}`
      : '';
  return { from: `From the ${word}${place}`, backLabel: `Back to ${word}` };
}

/**
 * U04: an encounter opened from a region card says where it came from ("From Deployment · Inference
 * & serving") and the chip is Back, which returns to the region with the stored camera. A format
 * switch made since then is the nearer origin, so it wins.
 */
export function encounterOrigin(
  trail: readonly EncounterEntry[],
  entry: EncounterEntry,
  regionLabel: string | undefined,
): EncounterOrigin | undefined {
  const switched = formatSwitchOrigin(trail, entry);
  if (switched || regionLabel === undefined || regionLabel === '') return switched;
  return { from: `From ${regionLabel}`, backLabel: 'Back to the map', icon: 'universe', tone: 'paper' };
}
