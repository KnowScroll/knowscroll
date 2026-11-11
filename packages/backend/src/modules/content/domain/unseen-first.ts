/**
 * The most met explanation units one unseen-first read carries. The caller reads the person's newest met units up to this
 * bound; a read with more is refused (`UNSEEN_FIRST_INVALID`). Past the bound a heavier reader's oldest met units are simply
 * not named, so retrieval may order them as unseen. That only changes which candidates retrieval reads first: the Composer's
 * own `encountered` exclusion filters the final pick from the evidence, so a met explanation is still never offered while an
 * unseen one exists (D-408).
 */
export const UNSEEN_FIRST_MAX_UNITS = 1000;

/** The longest explanation unit id Content stores (`explanation_unit_id` is at most 160 characters). */
const UNIT_ID_MAX = 160;

/**
 * What a read needs of the person's history to put their unseen explanations first (policy v2, D-408): the explanation units
 * they have met, as data. Content reads no personal table and runs no text a caller wrote: it orders its own rows by whether
 * the row's unit is in this list, bound as one array parameter.
 */
export interface UnseenFirst {
  readonly metUnitIds: readonly string[];
}

/**
 * The met unit ids of a caller's `unseenFirst`, checked: an array of at most {@link UNSEEN_FIRST_MAX_UNITS} non-empty ids
 * of at most 160 characters. Anything else is refused (`UNSEEN_FIRST_INVALID`).
 */
export function validateUnseenFirst(unseenFirst: UnseenFirst): readonly string[] {
  const ids: unknown = (unseenFirst as { readonly metUnitIds?: unknown } | null)?.metUnitIds;
  if (
    !Array.isArray(ids) ||
    ids.length > UNSEEN_FIRST_MAX_UNITS ||
    ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > UNIT_ID_MAX)
  )
    throw new Error('UNSEEN_FIRST_INVALID');
  return ids as readonly string[];
}
