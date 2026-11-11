import { canonicalSha256 } from '@knowscroll/scroll-model';
import { ReelDocumentSchema } from '@knowscroll/contracts';
import type { CoverageRef, CoverageTarget } from '../domain/coverage.js';
import { ReelCoverageProvenanceSchema, reelSegmentsOf, segmentIsSupported } from '../domain/reel-coverage.js';
import { ReadingFactsSchema } from './reading-facts-schema.js';

/** The stored rows a Reel's coverage target is read from. */
export interface StoredReelRevision {
  readonly document: unknown;
  readonly document_sha256: string;
  readonly explanation_unit_id: string;
  readonly provenance_kind: string;
  readonly provenance_version: string;
  readonly provenance: unknown;
  readonly reading_facts: unknown;
}

/** The twin Scroll revision the Reel's claims rest on, as stored. */
export interface StoredTwinRevision {
  readonly explanation_unit_id: string;
  readonly framing_kind: string | null;
}

const FACTUAL_FRAMING_SHA256 = canonicalSha256({ kind: 'factual' });

/**
 * The coverage target of a stored Reel revision (#674, slice 5.1): its segments, one for each narration
 * sentence of the approved script it was made from, each with the media window it is estimated to occupy and
 * whether every claim it cites rests on the twin Scroll. A Reel's framing is factual because it is a film of a
 * factual Scroll's claims, so its truth digest equals that of its twin and a Reel and its twin that bind one
 * facet are one support key with two references.
 *
 * `undefined` when the revision, its provenance, its facts and its twin do not agree, when it was not made from
 * an approved script (the Reels imported before scripts carried claims have no segments), when it is a fixture,
 * or when the twin is not a factual Scroll of the same explanation unit that a reader may be served.
 */
export function coverageTargetOfReel(
  row: StoredReelRevision,
  twin: StoredTwinRevision | undefined,
  ref: CoverageRef,
): CoverageTarget | undefined {
  const document = ReelDocumentSchema.safeParse(row.document);
  const provenance = ReelCoverageProvenanceSchema.safeParse(row.provenance);
  const facts = ReadingFactsSchema.safeParse(row.reading_facts);
  if (!document.success || !provenance.success || !facts.success || twin === undefined) return undefined;
  const record = provenance.data;
  if (
    document.data.fixture ||
    row.provenance_kind !== 'cutroom_import' ||
    record.schemaVersion !== row.provenance_version ||
    document.data.assetId !== ref.assetId ||
    document.data.revision !== ref.assetRevision ||
    facts.data.v !== 2 ||
    facts.data.reelDurationMs !== document.data.durationMs ||
    record.twin.explanationUnitId !== row.explanation_unit_id ||
    twin.explanation_unit_id !== row.explanation_unit_id ||
    twin.framing_kind !== 'factual'
  )
    return undefined;
  return {
    format: 'reel',
    documentSha256: row.document_sha256,
    provenanceSha256: canonicalSha256(row.provenance),
    explanationUnitId: row.explanation_unit_id,
    framing: 'factual',
    framingSha256: FACTUAL_FRAMING_SHA256,
    readingFactsVersion: 2,
    readingFactsSha256: canonicalSha256(facts.data),
    blocks: reelSegmentsOf(record.brief, document.data.durationMs).map((segment) => ({
      id: segment.id,
      type: 'segment',
      nested: false,
      truthSupported: segmentIsSupported(segment, record),
      span: [segment.startMs, segment.endMs] as const,
    })),
  };
}
