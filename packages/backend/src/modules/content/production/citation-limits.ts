import { PROVENANCE_V2_LIMITS, PROVENANCE_V3_LIMITS } from '@knowscroll/scroll-model/internal';
import type { AdmissionIssue } from '../application/ports.js';
import type { EvidencePassage } from './evidence.js';

/** The finding for a Scroll that cites more than its provenance can record. */
export const CITATIONS_TOO_MANY = 'citations_too_many';

/** The fixed hint the one repair gets for it. */
export const CITATIONS_TOO_MANY_HINT = `Cite fewer different passages in all: at most ${String(PROVENANCE_V2_LIMITS.claims)} across the whole Scroll. Reuse the passages that best support each part.`;

/** The same hint for a document v3, whose parts are beats, asides, pictures and the takeaway. */
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
): AdmissionIssue[] {
  const claimIds = new Set(Object.values(citations).flat());
  const sourceIds = new Set(
    passages.filter((passage) => claimIds.has(passage.claimId)).map((passage) => passage.pageId),
  );
  const over =
    claimIds.size > bounds.claims ||
    sourceIds.size > bounds.sources ||
    Object.keys(citations).length > bounds.citations;
  return over ? [{ code: CITATIONS_TOO_MANY, path: 'items' }] : [];
}

/**
 * Whether the claims a v2 Scroll cites fit the provenance that records them (`scroll-provenance.v2`:
 * claims, sources and parts have a bound). Checked while the answer is still being validated, so the
 * one repair can fix it, instead of after the paid answer is accepted. Pure.
 *
 * `citations` maps each stop, aside and the recap to the claim ids it cites.
 */
export function citationLimitIssues(
  citations: Readonly<Record<string, readonly string[]>>,
  passages: readonly EvidencePassage[],
): AdmissionIssue[] {
  return withinBounds(citations, passages, PROVENANCE_V2_LIMITS);
}

/**
 * {@link citationLimitIssues} for a document v3 (`scroll-provenance.v3`: 48 claims, 24 sources and 22 parts). The finding code
 * is the same, so one repair hint serves both; its text is {@link CITATIONS_TOO_MANY_HINT_V3}. `citations` maps each beat,
 * aside, picture and the takeaway to the claim ids it cites. Pure.
 */
export function citationLimitIssuesV3(
  citations: Readonly<Record<string, readonly string[]>>,
  passages: readonly EvidencePassage[],
): AdmissionIssue[] {
  return withinBounds(citations, passages, PROVENANCE_V3_LIMITS);
}
