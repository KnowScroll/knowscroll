import { z } from '../zod.js';
import { LocalId, OpaqueId, Revision, Sha256Hex } from '../primitives.js';
import { CheckRecord, Claim, ProductionRecord, Source } from './provenance.js';

/**
 * `scroll-provenance.v3`: what a published `scroll-document.v3` rests on. The claims, sources and production record of
 * v1 and v2; like v2, a part rests on the claims it cites as a whole. A part is a beat, an aside, a picture (by their
 * ids) or the end summary (`takeaway`). Backend-only: stored beside the revision and never served to readers.
 */
export const SCROLL_PROVENANCE_V3_SCHEMA_VERSION = 'scroll-provenance.v3';

/** The part id the end summary is cited under. Document ids never take it: it is not a beat, aside or picture id. */
export const TAKEAWAY_PART_ID = 'takeaway';

/** What one document v3 revision's provenance can record: 14 beats, 4 asides, 3 pictures and the takeaway at most. */
export const PROVENANCE_V3_LIMITS = { claims: 48, sources: 24, citations: 22 } as const;

export const ScrollProvenanceV3 = z.strictObject({
  schemaVersion: z.literal(SCROLL_PROVENANCE_V3_SCHEMA_VERSION),
  assetId: OpaqueId,
  revision: Revision,
  /** `integrity.sha256` of the document revision this provenance belongs to. */
  documentSha256: Sha256Hex,
  /** The passages the document cites, verbatim, each the exact text of its source snapshot. */
  claims: z.array(Claim).max(PROVENANCE_V3_LIMITS.claims),
  sources: z.array(Source).max(PROVENANCE_V3_LIMITS.sources),
  /** For each beat, aside, picture and the takeaway, the claims it cites. Every part cites at least one. */
  citations: z
    .array(z.strictObject({ partId: LocalId, claimIds: z.array(OpaqueId).min(1).max(8) }))
    .max(PROVENANCE_V3_LIMITS.citations)
    .refine((entries) => new Set(entries.map((entry) => entry.partId)).size === entries.length, {
      message: 'citation_part_duplicate',
    }),
  checks: z.array(CheckRecord).max(32),
  production: ProductionRecord,
});
export type ScrollProvenanceV3 = z.infer<typeof ScrollProvenanceV3>;
