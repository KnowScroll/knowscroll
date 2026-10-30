import { callsOf, parseDocumentV2, SCROLL_DOCUMENT_V2_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadScrollCalls, ScrollCallFacts } from '../public.js';

/**
 * Stored revisions are immutable, so the calls read from one can be kept. A small bounded cache,
 * oldest first out: parsing a 128 KiB document for every lock would cost for nothing.
 */
const CACHE_LIMIT = 32;
const cache = new Map<string, readonly ScrollCallFacts[]>();

/**
 * See `ReadScrollCalls`. Reads the stored consumer document of one Scroll revision (never its
 * provenance), on the client path (structure and bounds; admission already proved the rest), and
 * keeps only what judging a pick needs. No lock and no network.
 */
export const readScrollCalls: ReadScrollCalls = async (scope, assetId, revision) => {
  const key = `${assetId}@${String(revision)}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const row = await transactionOf(scope)
    .selectFrom('content.asset_revisions as revision')
    .innerJoin('content.assets as asset', 'asset.id', 'revision.asset_id')
    .select('revision.document')
    .where('revision.asset_id', '=', assetId)
    .where('revision.revision', '=', revision)
    .where('asset.kind', '=', 'scroll')
    .executeTakeFirst();
  if (
    (row?.document as { schemaVersion?: unknown } | null | undefined)?.schemaVersion !==
    SCROLL_DOCUMENT_V2_SCHEMA_VERSION
  )
    return undefined;
  const parsed = parseDocumentV2(row?.document);
  if (parsed.kind !== 'valid') return undefined;
  const facts = callsOf(parsed.document).map((call): ScrollCallFacts => ({
    stopId: call.id,
    kind: call.kind,
    optionCount: call.options.length,
    answer: call.answer,
  }));
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, facts);
  return facts;
};
