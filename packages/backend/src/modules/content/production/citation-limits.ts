import { PROVENANCE_V2_LIMITS } from '@knowscroll/scroll-model/internal';
import type { AdmissionIssue } from '../application/ports.js';
import type { EvidencePassage } from './evidence.js';

/** The finding for a Scroll that cites more than its provenance can record. */
export const CITATIONS_TOO_MANY = 'citations_too_many';

/** The fixed hint the one repair gets for it. */
export const CITATIONS_TOO_MANY_HINT = `Cite fewer different passages in all: at most ${String(PROVENANCE_V2_LIMITS.claims)} across the whole Scroll. Reuse the passages that best support each part.`;

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
  const claimIds = new Set(Object.values(citations).flat());
  const sourceIds = new Set(
    passages.filter((passage) => claimIds.has(passage.claimId)).map((passage) => passage.pageId),
  );
  const over =
    claimIds.size > PROVENANCE_V2_LIMITS.claims ||
    sourceIds.size > PROVENANCE_V2_LIMITS.sources ||
    Object.keys(citations).length > PROVENANCE_V2_LIMITS.citations;
  return over ? [{ code: CITATIONS_TOO_MANY, path: 'items' }] : [];
}
