import { sql } from 'kysely';
import { callsOf, parseDocumentV2, SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { notUnderReview } from './review-gate-sql.js';
import type { ReadScrollCalls, ScrollCallFacts } from '../public.js';

/**
 * See `ReadScrollCalls`. Reads the stored consumer document of one Scroll revision (never its
 * provenance), on the client path (structure and bounds; admission already proved the rest), and
 * keeps only what judging a pick needs. A revision the review gate holds or rejected reads as
 * absent, like every read that takes an exact revision from its caller (D-138). No lock and no
 * network. A person locks at most four calls a Scroll, so nothing is cached: every read asks the
 * gate again.
 */
export const readScrollCalls: ReadScrollCalls = async (scope, assetId, revision) => {
  const row = await transactionOf(scope)
    .selectFrom('content.asset_revisions as revision')
    .innerJoin('content.assets as asset', 'asset.id', 'revision.asset_id')
    .select('revision.document')
    .where('revision.asset_id', '=', assetId)
    .where('revision.revision', '=', revision)
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
  return callsOf(parsed.document).map((call): ScrollCallFacts => ({
    stopId: call.id,
    kind: call.kind,
    optionCount: call.options.length,
    answer: call.answer,
  }));
};
