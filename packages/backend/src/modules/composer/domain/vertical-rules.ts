import type { ComposerSnapshot, RelatedTargetOutcome, StickyFormatOutcome } from './types.js';

type Candidate = ComposerSnapshot['candidates'][number];

/** A candidate with the reasons it cannot be offered; empty means eligible so far. */
export interface Screened {
  readonly candidate: Candidate;
  readonly exclusions: readonly string[];
}

/**
 * Whether the candidate is another part of the series the person is in, in any revision of that series.
 * Moving to a part is a series move (the Part tab or swipe); a vertical move is a new subject, so it
 * never offers one. Only vertical moves ask: a series move exists to reach exactly these.
 */
export function inCurrentSeries(snapshot: ComposerSnapshot, candidate: Candidate): boolean {
  const { currentSeriesId } = snapshot.intent;
  return (
    snapshot.mode === 'vertical' &&
    currentSeriesId !== undefined &&
    candidate.encounter.series?.seriesId === currentSeriesId
  );
}

/**
 * Related-target rule for a vertical move: a candidate the person can reach by the Related tab, or the
 * format twin of one, is another perspective on this thread, not a new subject, so it is excluded
 * (`related_target`). When that would leave nothing eligible in either format the rule steps aside and
 * the outcome says it fell back, so the move still offers something. It runs before sticky format: a
 * new topic matters more than the format when both cannot be had.
 */
export function applyRelatedExclusion<T extends Screened>(
  snapshot: ComposerSnapshot,
  screened: readonly T[],
): { readonly screened: readonly T[]; readonly related?: RelatedTargetOutcome } {
  const targets = snapshot.intent.relatedAssetIds;
  if (snapshot.mode !== 'vertical' || targets === undefined || targets.length === 0) return { screened };
  const isTarget = ({ candidate }: Screened) =>
    targets.includes(candidate.encounter.assetId) ||
    candidate.encounter.siblings.some((sibling) => targets.includes(sibling.assetId));
  const matched = screened.filter((entry) => isTarget(entry) && entry.exclusions.length === 0).length;
  const marked = screened.map((entry) =>
    isTarget(entry) ? { ...entry, exclusions: [...entry.exclusions, 'related_target'] } : entry,
  );
  const fellBack = matched > 0 && !marked.some((entry) => entry.exclusions.length === 0);
  return fellBack
    ? { screened, related: { outcome: 'fell_back', matched } }
    : { screened: marked, related: { outcome: 'applied', matched } };
}

/**
 * Sticky format for a vertical move: while any candidate of the person's format is still eligible
 * the other format is excluded (`format_sticky`), so the next subject stays in the format the person
 * is in. When none is eligible nothing is excluded and the outcome says it fell back. The rule never
 * reads a stored preference: Reel and Scroll keep equal status, and this follows only what the
 * person is in right now.
 */
export function applyStickyFormat<T extends Screened>(
  snapshot: ComposerSnapshot,
  screened: readonly T[],
): { readonly screened: readonly T[]; readonly sticky?: StickyFormatOutcome } {
  const preferred = snapshot.intent.stickyFormat;
  if (snapshot.mode !== 'vertical' || preferred === undefined) return { screened };
  const kept = screened.some(
    ({ candidate, exclusions }) => exclusions.length === 0 && candidate.encounter.kind === preferred,
  );
  const sticky: StickyFormatOutcome = { preferred, outcome: kept ? 'kept' : 'fell_back' };
  if (!kept) return { screened, sticky };
  return {
    screened: screened.map((entry) =>
      entry.candidate.encounter.kind === preferred
        ? entry
        : { ...entry, exclusions: [...entry.exclusions, 'format_sticky'] },
    ),
    sticky,
  };
}
