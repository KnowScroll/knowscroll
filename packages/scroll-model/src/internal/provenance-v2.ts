import { z } from '../zod.js';
import { LocalId, OpaqueId, Revision, Sha256Hex } from '../primitives.js';
import { CheckRecord, Claim, ProductionRecord, Source } from './provenance.js';

/**
 * `scroll-provenance.v2`: what a published `scroll-document.v2` rests on. The same claims, sources
 * and production record as `scroll-provenance.v1`; where v1 binds a claim to a character range of a
 * block, a v2 part (a stop, an aside, the recap) rests on the claims it cites as a whole, so the
 * record is the list of citations by the document's own ids. Backend-only: stored beside the
 * revision and never served to readers.
 */
export const SCROLL_PROVENANCE_V2_SCHEMA_VERSION = 'scroll-provenance.v2';

export const ScrollProvenanceV2 = z.strictObject({
  schemaVersion: z.literal(SCROLL_PROVENANCE_V2_SCHEMA_VERSION),
  assetId: OpaqueId,
  revision: Revision,
  /** `integrity.sha256` of the document revision this provenance belongs to. */
  documentSha256: Sha256Hex,
  /** The passages the document cites, verbatim, each the exact text of its source snapshot. */
  claims: z.array(Claim).max(48),
  sources: z.array(Source).max(24),
  /** For each stop, aside and the recap (`recap`), the claims it cites. Every part cites at least one. */
  citations: z
    .array(z.strictObject({ partId: LocalId, claimIds: z.array(OpaqueId).min(1).max(8) }))
    .max(32)
    .refine((entries) => new Set(entries.map((entry) => entry.partId)).size === entries.length, {
      message: 'citation_part_duplicate',
    }),
  checks: z.array(CheckRecord).max(32),
  production: ProductionRecord,
});
export type ScrollProvenanceV2 = z.infer<typeof ScrollProvenanceV2>;
