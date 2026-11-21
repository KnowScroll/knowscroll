import { sql } from 'kysely';
import {
  beatsOfV3,
  parseDocumentV2,
  parseDocumentV3,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  type ScrollDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import type { PersonalScopeTx } from '../../identity/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { notRetired } from './retirement-sql.js';
import { notUnderReview } from './review-gate-sql.js';
import type { ContentRef, ReadScrollAskFacts } from '../public.js';

type Stop = ScrollDocumentV2['stops'][number];

/** The words of one stop as a reader sees them: its lines, or the question a call asks. */
function stopText(stop: Stop): string {
  return stop.kind === 'read' ? stop.blocks.map((block) => block.text).join(' ') : stop.prompt;
}

/** A stored essay: a v2 (its stops are the places) or a v3 (its beats are). */
export type StoredEssay = ScrollDocumentV2 | ScrollDocumentV3;

/**
 * The stored consumer document of one Scroll revision (never its provenance), read inside the caller's personal
 * transaction. A revision the review gate holds or rejected reads as absent, like every read that takes an exact
 * revision from its caller (D-138), and so does one of an asset that is not admitted (withdrawn, D-418) and a document
 * that is neither a `scroll-document.v2` nor a `scroll-document.v3`: the parse alone refuses a v1 document and an absent
 * row. An older revision of an admitted asset still reads, unless a document v3 retired it (D-435): then it reads as absent. No lock and no network.
 */
export async function readStoredEssay(scope: PersonalScopeTx, ref: ContentRef): Promise<StoredEssay | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('content.asset_revisions as revision')
    .innerJoin('content.assets as asset', 'asset.id', 'revision.asset_id')
    .select('revision.document')
    .where('revision.asset_id', '=', ref.assetId)
    .where('revision.revision', '=', ref.assetRevision)
    .where('asset.kind', '=', 'scroll')
    .where('asset.status', '=', 'admitted')
    .where(sql<boolean>`${notUnderReview('revision.asset_id', 'revision.revision')}`)
    .where(sql<boolean>`${notRetired('revision.asset_id', 'revision.revision')}`)
    .executeTakeFirst();
  const parsed =
    (row?.document as { schemaVersion?: unknown } | null | undefined)?.schemaVersion ===
    SCROLL_DOCUMENT_V3_SCHEMA_VERSION
      ? parseDocumentV3(row?.document)
      : parseDocumentV2(row?.document);
  return parsed.kind === 'valid' ? parsed.document : undefined;
}

/**
 * See `ReadScrollAskFacts`. Keeps the title, the anchored stop's (or beat's) words and the questions the Scroll
 * suggests. A document with no such place reads as absent.
 */
export const readScrollAskFacts: ReadScrollAskFacts = async (scope, ref, anchorId) => {
  const document = await readStoredEssay(scope, ref);
  if (document === undefined) return undefined;
  if (document.schemaVersion === SCROLL_DOCUMENT_V3_SCHEMA_VERSION) {
    const beat = beatsOfV3(document).find((candidate) => candidate.id === anchorId);
    return beat === undefined
      ? undefined
      : { title: document.title, stopText: beat.text, suggestions: document.askSuggestions };
  }
  const stop = document.stops.find((candidate) => candidate.id === anchorId);
  return stop === undefined
    ? undefined
    : { title: document.title, stopText: stopText(stop), suggestions: document.askSuggestions };
};
