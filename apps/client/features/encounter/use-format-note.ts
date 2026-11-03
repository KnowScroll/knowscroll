import { useCallback, useEffect, useState } from 'react';
import type { EncounterEntry } from './encounter-history';
import { formatNoteOf, type FormatNote } from './format-note';

/** The entries whose "Next topic" note has been shown: it is said once per Scroll, even if the screen is drawn again. */
const noted = new WeakSet<EncounterEntry>();

/**
 * The "Next topic" note of a Scroll entry (V3 G4, D-364, D-391), for either reader of a Scroll: the note while it is due, and
 * the call that puts it away. Due only the first time the entry is drawn, and only when the trail says a new topic landed here.
 */
export function useFormatNote(
  trail: readonly EncounterEntry[],
  entry: Extract<EncounterEntry, { kind: 'scroll' }>,
): { readonly note: FormatNote | undefined; readonly putAway: () => void } {
  const [note, setNote] = useState(() => (noted.has(entry) ? undefined : formatNoteOf(trail, entry)));
  useEffect(() => {
    noted.add(entry);
  }, [entry]);
  const putAway = useCallback(() => setNote(undefined), []);
  return { note, putAway };
}
