import { formatClock } from '@knowscroll/ui';
import type { KeepPlaceState } from '@knowscroll/client-core';
import type { PrivatePosition } from '../encounter/encounter-history';
import type { SavedItem } from './saved-query';

/** The place the server holds for exactly this saved version, when it is known and set. */
export function serverPositionOf(place: KeepPlaceState | undefined, item: SavedItem) {
  return place?.status === 'ready' &&
    place.snapshot?.status === 'available' &&
    place.snapshot.entry.savedEntryId === item.savedEntryId &&
    place.snapshot.entry.assetId === item.assetId &&
    place.snapshot.entry.assetRevision === item.assetRevision &&
    place.snapshot.place.status === 'set'
    ? place.snapshot.place.position
    : undefined;
}

/**
 * One calm line under a saved card: where the person left off, or why there is no place. It
 * never counts, grades or says "watched" (S01). A Reel place is a playhead; a Scroll place is
 * only "kept", because a block title is not part of the saved record.
 */
export function positionLine(
  item: SavedItem,
  place: KeepPlaceState | undefined,
  resume: PrivatePosition | undefined,
): string {
  if (item.availability === 'withdrawn') return 'Withdrawn after you kept it';
  if (item.availability === 'corrected') return 'Revised since you kept it';
  const saved = serverPositionOf(place, item);
  if (saved?.kind === 'reel' && saved.positionMs >= 1000) return `Paused at ${formatClock(saved.positionMs)}`;
  if (saved?.kind === 'scroll') return 'Your place is kept';
  if (place?.status === 'unavailable') return "Couldn't check your place";
  if (place?.status === 'ready' && place.snapshot?.status === 'not_saved') return 'No longer in Keep';
  if (place?.status === 'ready' && place.snapshot?.status === 'saved_unavailable')
    return "This version's place isn't available";
  if (place === undefined && resume?.kind === 'reel' && resume.positionMs >= 1000)
    return `Paused at ${formatClock(resume.positionMs)}`;
  if (place === undefined && resume?.kind === 'scroll') return 'Your place is kept';
  return 'Not started';
}
