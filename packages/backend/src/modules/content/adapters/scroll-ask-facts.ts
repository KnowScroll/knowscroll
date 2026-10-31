import { sql } from 'kysely';
import { parseDocumentV2, SCROLL_DOCUMENT_V2_SCHEMA_VERSION, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { notUnderReview } from './review-gate-sql.js';
import type { ReadScrollAskFacts } from '../public.js';

type Stop = ScrollDocumentV2['stops'][number];

/** The words of one stop as a reader sees them: its lines, or the question a call asks. */
function stopText(stop: Stop): string {
  return stop.kind === 'read' ? stop.blocks.map((block) => block.text).join(' ') : stop.prompt;
}

/**
 * See `ReadScrollAskFacts`. Reads the stored consumer document of one Scroll revision (never its provenance)
 * and keeps the title, the anchored stop's words and the questions the Scroll suggests. A revision the review
 * gate holds or rejected reads as absent, like every read that takes an exact revision from its caller (D-138),
 * and so does a document that is not a `scroll-document.v2` or has no such stop. No lock and no network.
 */
export const readScrollAskFacts: ReadScrollAskFacts = async (scope, ref, stopId) => {
  const row = await transactionOf(scope)
    .selectFrom('content.asset_revisions as revision')
    .innerJoin('content.assets as asset', 'asset.id', 'revision.asset_id')
    .select('revision.document')
    .where('revision.asset_id', '=', ref.assetId)
    .where('revision.revision', '=', ref.assetRevision)
    .where('asset.kind', '=', 'scroll')
    .where(sql<boolean>`${notUnderReview('revision.asset_id', 'revision.revision')}`)
    .executeTakeFirst();
  if (
    (row?.document as { schemaVersion?: unknown } | null | undefined)?.schemaVersion !==
    SCROLL_DOCUMENT_V2_SCHEMA_VERSION
  )
    return undefined;
  const parsed = parseDocumentV2(row?.document);
  if (parsed.kind !== 'valid') return undefined;
  const stop = parsed.document.stops.find((candidate) => candidate.id === stopId);
  if (stop === undefined) return undefined;
  return {
    title: parsed.document.title,
    stopText: stopText(stop),
    suggestions: parsed.document.askSuggestions,
  };
};
