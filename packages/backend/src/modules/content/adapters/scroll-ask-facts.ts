import { sql } from 'kysely';
import { parseDocumentV2, type ScrollDocumentV2 } from '@knowscroll/scroll-model';
import type { PersonalScopeTx } from '../../identity/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { notUnderReview } from './review-gate-sql.js';
import type { ContentRef, ReadScrollAskFacts } from '../public.js';

type Stop = ScrollDocumentV2['stops'][number];

/** The words of one stop as a reader sees them: its lines, or the question a call asks. */
function stopText(stop: Stop): string {
  return stop.kind === 'read' ? stop.blocks.map((block) => block.text).join(' ') : stop.prompt;
}

/**
 * The stored consumer document of one Scroll revision (never its provenance), read inside the caller's personal
 * transaction. A revision the review gate holds or rejected reads as absent, like every read that takes an exact
 * revision from its caller (D-138), and so does a document that is not a `scroll-document.v2`: the v2 parse alone
 * refuses a v1 document and an absent row. No lock and no network.
 */
export async function readStoredDocumentV2(
  scope: PersonalScopeTx,
  ref: ContentRef,
): Promise<ScrollDocumentV2 | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('content.asset_revisions as revision')
    .innerJoin('content.assets as asset', 'asset.id', 'revision.asset_id')
    .select('revision.document')
    .where('revision.asset_id', '=', ref.assetId)
    .where('revision.revision', '=', ref.assetRevision)
    .where('asset.kind', '=', 'scroll')
    .where(sql<boolean>`${notUnderReview('revision.asset_id', 'revision.revision')}`)
    .executeTakeFirst();
  const parsed = parseDocumentV2(row?.document);
  return parsed.kind === 'valid' ? parsed.document : undefined;
}

/**
 * See `ReadScrollAskFacts`. Keeps the title, the anchored stop's words and the questions the Scroll suggests. A
 * document with no such stop reads as absent.
 */
export const readScrollAskFacts: ReadScrollAskFacts = async (scope, ref, stopId) => {
  const document = await readStoredDocumentV2(scope, ref);
  const stop = document?.stops.find((candidate) => candidate.id === stopId);
  if (document === undefined || stop === undefined) return undefined;
  return { title: document.title, stopText: stopText(stop), suggestions: document.askSuggestions };
};
