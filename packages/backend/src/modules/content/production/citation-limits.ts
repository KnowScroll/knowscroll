import { PROVENANCE_V3_LIMITS } from '@knowscroll/scroll-model/internal';
import type { AdmissionIssue } from '../application/ports.js';
import type { EvidencePassage } from './evidence.js';

/** The finding for a Scroll that cites more than its provenance can record. */
export const CITATIONS_TOO_MANY = 'citations_too_many';

/** The fixed hint the one repair gets for it: a document v3's parts are beats, asides, pictures and the takeaway. */
export const CITATIONS_TOO_MANY_HINT_V3 = `Cite fewer different passages in all: at most ${String(PROVENANCE_V3_LIMITS.claims)} across the whole Scroll, from at most ${String(PROVENANCE_V3_LIMITS.sources)} pages, and cite from at most ${String(PROVENANCE_V3_LIMITS.citations)} parts (beats, asides, pictures and the takeaway). Reuse the passages that best support each part.`;

/** The bounds of one provenance schema that a citation map must fit. */
interface ProvenanceBounds {
  readonly claims: number;
  readonly sources: number;
  readonly citations: number;
}

function withinBounds(
  citations: Readonly<Record<string, readonly string[]>>,
  passages: readonly EvidencePassage[],
  bounds: ProvenanceBounds,
  path = 'items',
): AdmissionIssue[] {
  const claimIds = new Set(Object.values(citations).flat());
  const sourceIds = new Set(
    passages.filter((passage) => claimIds.has(passage.claimId)).map((passage) => passage.pageId),
  );
  const over =
    claimIds.size > bounds.claims ||
    sourceIds.size > bounds.sources ||
    Object.keys(citations).length > bounds.citations;
  return over ? [{ code: CITATIONS_TOO_MANY, path }] : [];
}

/**
 * Whether the claims a document v3 cites fit the provenance that records them (`scroll-provenance.v3`: 48 claims, 24 sources and 22 parts), checked while the answer is still being validated, so the one repair can fix it. The finding code
 * is the same; its hint is {@link CITATIONS_TOO_MANY_HINT_V3}. `citations` maps each beat, aside, picture and the takeaway to
 * the claim ids it cites. The finding sits at `path`, the part of the model's own reply the one repair can change: `items` for
 * a reply that holds the essay, `pictures` for a staging reply, whose prose is fixed. Pure.
 */
export function citationLimitIssuesV3(
  citations: Readonly<Record<string, readonly string[]>>,
  passages: readonly EvidencePassage[],
  path = 'items',
): AdmissionIssue[] {
  return withinBounds(citations, passages, PROVENANCE_V3_LIMITS, path);
}
