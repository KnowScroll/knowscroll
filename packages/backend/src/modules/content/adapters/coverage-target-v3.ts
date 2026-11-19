import { canonicalSha256, validateDocumentV3 } from '@knowscroll/scroll-model';
import { ScrollProvenanceV3 } from '@knowscroll/scroll-model/internal';
import type { CoverageRef, CoverageTarget } from '../domain/coverage.js';
import { readingFactsOfV3 } from './reading-facts-v3.js';
import type { StoredRevisionV2 } from './coverage-target-v2.js';

/** Which stored provenance kind goes with which production record: a person's authored Scroll, or a model's. */
const LINEAGE: Readonly<Record<string, string>> = { authored_editorial: 'authored-editorial', generated: 'model' };

/**
 * The coverage target of a stored `scroll-document.v3` revision (#761): its document re-admitted from the stored
 * bytes, its provenance, and its beats. A beat is truth-supported when it cites at least one claim and every claim it
 * cites is documented or a synthesis; quote beats count like any other. `undefined` when the revision, its provenance
 * and its lineage do not agree, or when it is not a factual Scroll. Unlike v2 it admits an authored editorial Scroll
 * as well as a model's: the hand-written fixtures are the first document v3 Scrolls (D-430).
 */
export function coverageTargetOfV3(row: StoredRevisionV2, ref: CoverageRef): CoverageTarget | undefined {
  const admitted = validateDocumentV3(row.document);
  const provenance = ScrollProvenanceV3.safeParse(row.provenance);
  if (admitted.kind !== 'valid' || !provenance.success) return undefined;
  const document = admitted.document;
  const record = provenance.data;
  if (
    LINEAGE[row.provenance_kind] !== record.production.kind ||
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
  const facts = readingFactsOfV3(document);
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
