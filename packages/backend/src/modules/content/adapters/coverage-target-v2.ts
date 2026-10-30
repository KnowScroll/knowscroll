import { canonicalSha256, validateDocumentV2 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import type { CoverageRef, CoverageTarget } from '../domain/coverage.js';
import { readingFactsOfV2 } from './reading-facts-v2.js';

/** The stored rows a coverage target is read from. */
export interface StoredRevisionV2 {
  readonly document: unknown;
  readonly document_sha256: string;
  readonly explanation_unit_id: string;
  readonly provenance_kind: string;
  readonly provenance_version: string;
  readonly provenance: unknown;
}

/**
 * The coverage target of a stored `scroll-document.v2` revision: its document re-admitted from the
 * stored bytes, its provenance, and its reading units. A stop is truth-supported when it cites at
 * least one claim and every claim it cites is documented or a synthesis; a call is a unit but is
 * never eligible (`coverageLocatorTypes`). `undefined` when the revision, its provenance and its
 * lineage do not agree, or when it is not a factual model-produced Scroll.
 */
export function coverageTargetOfV2(row: StoredRevisionV2, ref: CoverageRef): CoverageTarget | undefined {
  const admitted = validateDocumentV2(row.document);
  const provenance = ScrollProvenanceV2.safeParse(row.provenance);
  if (admitted.kind !== 'valid' || !provenance.success) return undefined;
  const document = admitted.document;
  const record = provenance.data;
  if (
    record.production.kind !== 'model' ||
    row.provenance_kind !== 'generated' ||
    record.schemaVersion !== row.provenance_version ||
    document.assetId !== ref.assetId ||
    document.revision !== ref.assetRevision ||
    document.integrity.sha256 !== row.document_sha256 ||
    document.explanationUnitId !== row.explanation_unit_id ||
    record.assetId !== ref.assetId ||
    record.revision !== ref.assetRevision ||
    record.documentSha256 !== document.integrity.sha256 ||
    document.framing.kind !== 'factual'
  )
    return undefined;
  const facts = readingFactsOfV2(document);
  const truth = new Map(record.claims.map((claim) => [claim.claimId, claim.truthState]));
  const cited = new Map(record.citations.map((entry) => [entry.partId, entry.claimIds]));
  return {
    documentSha256: document.integrity.sha256,
    provenanceSha256: canonicalSha256(record),
    explanationUnitId: document.explanationUnitId,
    framing: document.framing.kind,
    framingSha256: canonicalSha256(document.framing),
    readingFactsVersion: facts.v,
    readingFactsSha256: canonicalSha256(facts),
    blocks: facts.blocks.map((block) => {
      const claimIds = cited.get(block.id) ?? [];
      return {
        id: block.id,
        type: block.type,
        nested: false,
        truthSupported:
          claimIds.length > 0 &&
          claimIds.every((claimId) => ['documented', 'synthesis'].includes(truth.get(claimId) ?? 'unknown')),
      };
    }),
  };
}
