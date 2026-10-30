import { sql, type Kysely, type Transaction } from 'kysely';
import { parseDocumentV2, readingWords } from '@knowscroll/scroll-model';
import { ScrollProvenanceV2 } from '@knowscroll/scroll-model/internal';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import { RECIPE_KEYS, RECIPES, type RecipeKey } from '../domain/library/index.js';
import {
  decideReject,
  decideRelease,
  parseRejectReason,
  type RejectRefusal,
  type ReleaseRefusal,
  type ReviewState,
} from '../domain/review.js';
import { reviewTextOf, type ReviewEvidence } from './review-text.js';

/** One revision at the review gate, as the operator's list shows it. Never any body text. */
export interface ReviewListing {
  readonly assetId: string;
  /** The library recipe that produced the Scroll, when the plan still names its asset. */
  readonly recipe: RecipeKey | null;
  readonly revision: number;
  readonly state: ReviewState;
  readonly title: string;
  readonly words: number;
  readonly readingMinutes: number;
  readonly stops: number;
  readonly calls: number;
  readonly hasPicture: boolean;
  /** Whether the recipe's planet and angle are mapped to this revision (what formation needs). */
  readonly coverage: 'mapped' | 'unmapped';
  /** The revision the asset serves now, when it serves one. */
  readonly servedRevision: number | null;
  readonly heldAt: string;
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly reason: string | null;
}

export type ReviewShowResult =
  | { readonly kind: 'shown'; readonly listing: ReviewListing; readonly text: string }
  | { readonly kind: 'refused'; readonly reason: 'not_under_review' | 'ambiguous_revision' | 'document_unreadable' };

export type ReleaseResult =
  | {
      readonly kind: 'released' | 'already_released';
      readonly assetId: string;
      readonly revision: number;
      /** The revision that was served before, when there was one. */
      readonly replacedRevision: number | null;
    }
  | { readonly kind: 'refused'; readonly reason: ReleaseRefusal };

export type RejectResult =
  | { readonly kind: 'rejected' | 'already_rejected'; readonly assetId: string; readonly revision: number }
  | { readonly kind: 'refused'; readonly reason: RejectRefusal | 'reason_invalid' };

interface ListingRow {
  asset_id: string;
  revision: number;
  state: ReviewState;
  title: string;
  document: unknown;
  held_at: Date;
  decided_at: Date | null;
  decided_by: string | null;
  reason: string | null;
  served_revision: number | null;
  asset_status: string;
  mapped: boolean;
}

const recipeOfAsset = new Map<string, RecipeKey>(RECIPE_KEYS.map((key) => [RECIPES[key].assetId, key]));

/** The library recipe whose Scroll an asset is, or `null` for an asset the plan does not name. */
export function recipeKeyOfAsset(assetId: string): RecipeKey | null {
  return recipeOfAsset.get(assetId.toLowerCase()) ?? null;
}

function listingOf(row: ListingRow): ReviewListing | undefined {
  const parsed = parseDocumentV2(row.document);
  if (parsed.kind !== 'valid') return undefined;
  const { document } = parsed;
  return {
    assetId: row.asset_id,
    recipe: recipeOfAsset.get(row.asset_id) ?? null,
    revision: row.revision,
    state: row.state,
    title: row.title,
    words: readingWords(document),
    readingMinutes: document.measures.readingMinutes,
    stops: document.stops.length,
    calls: document.stops.filter((stop) => stop.kind !== 'read').length,
    hasPicture: document.stage !== undefined,
    coverage: row.mapped ? 'mapped' : 'unmapped',
    servedRevision: row.asset_status === 'admitted' ? row.served_revision : null,
    heldAt: row.held_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    decidedBy: row.decided_by,
    reason: row.reason,
  };
}

/** The review rows of one asset or of every asset, with what the operator's list needs. */
async function readListingRows(
  db: Kysely<Database> | Transaction<Database>,
  where: { readonly assetId?: string; readonly revision?: number; readonly onlyHeld: boolean },
): Promise<readonly ListingRow[]> {
  const { rows } = await sql<ListingRow>`
    select review.asset_id, review.revision, review.state, revision.title, revision.document,
      review.held_at, review.decided_at, review.decided_by, review.reason,
      asset.revision as served_revision, asset.status as asset_status,
      exists (select 1 from content.coverage_heads head
        join content.coverage_revisions mapping on mapping.asset_id = head.asset_id
          and mapping.asset_revision = head.asset_revision and mapping.revision = head.revision
        where head.asset_id = review.asset_id and head.asset_revision = review.revision
          and mapping.status = 'active') as mapped
    from content.revision_reviews review
    join content.asset_revisions revision on revision.asset_id = review.asset_id and revision.revision = review.revision
    join content.assets asset on asset.id = review.asset_id
    where (${where.onlyHeld} = false or review.state = 'held')
      and (${where.assetId ?? null}::uuid is null or review.asset_id = ${where.assetId ?? null}::uuid)
      and (${where.revision ?? null}::integer is null or review.revision = ${where.revision ?? null}::integer)
    order by review.held_at, review.asset_id, review.revision`.execute(db);
  return rows;
}

/** The quotes each part of a stored v2 Scroll cites and the pages they come from, for a factual read. */
async function readEvidence(
  db: Kysely<Database> | Transaction<Database>,
  assetId: string,
  revision: number,
): Promise<ReviewEvidence | undefined> {
  const row = await db
    .selectFrom('content.asset_provenance')
    .select('provenance')
    .where('asset_id', '=', assetId)
    .where('revision', '=', revision)
    .executeTakeFirst();
  const parsed = ScrollProvenanceV2.safeParse(row?.provenance);
  if (!parsed.success) return undefined;
  const quoteOf = new Map(parsed.data.claims.map((claim) => [claim.claimId, claim.quote]));
  const quotesByPart = new Map(
    parsed.data.citations.map((entry) => [
      entry.partId,
      entry.claimIds.flatMap((id) => (quoteOf.has(id) ? [quoteOf.get(id)!] : [])),
    ]),
  );
  return { quotesByPart, sources: parsed.data.sources.map((source) => `${source.title} (${source.url})`) };
}

async function lockAssetForReview(trx: Transaction<Database>, assetId: string) {
  // The lock admission takes, so a release never interleaves with a revision being stored.
  await sql`select pg_advisory_xact_lock(hashtextextended(${`content.asset:${assetId}`}, 0))`.execute(trx);
  return trx
    .selectFrom('content.assets')
    .select(['kind', 'status', 'revision'])
    .where('id', '=', assetId)
    .forUpdate()
    .executeTakeFirst();
}

async function lockReview(trx: Transaction<Database>, assetId: string, revision: number) {
  return trx
    .selectFrom('content.revision_reviews')
    .select('state')
    .where('asset_id', '=', assetId)
    .where('revision', '=', revision)
    .forUpdate()
    .executeTakeFirst();
}

/** The revisions waiting for a decision, or with `all` every revision that went through the gate. */
async function listRevisions(db: Kysely<Database>, options: { readonly all: boolean }) {
  const rows = await readListingRows(db, { onlyHeld: !options.all });
  return rows.flatMap((row) => listingOf(row) ?? []);
}

/**
 * The text of a revision under review. Without a revision, the asset's one held revision. With
 * `withSources`, the passages each part cites follow it.
 */
async function showRevision(
  db: Kysely<Database>,
  request: { readonly assetId: string; readonly revision?: number; readonly withSources: boolean },
): Promise<ReviewShowResult> {
  const rows = await readListingRows(db, {
    assetId: request.assetId,
    ...(request.revision === undefined ? {} : { revision: request.revision }),
    onlyHeld: request.revision === undefined,
  });
  if (rows.length === 0) return { kind: 'refused', reason: 'not_under_review' };
  const [row] = rows;
  if (rows.length > 1 || row === undefined) return { kind: 'refused', reason: 'ambiguous_revision' };
  const listing = listingOf(row);
  const parsed = parseDocumentV2(row.document);
  if (listing === undefined || parsed.kind !== 'valid') return { kind: 'refused', reason: 'document_unreadable' };
  const evidence = request.withSources ? await readEvidence(db, row.asset_id, row.revision) : undefined;
  return { kind: 'shown', listing, text: reviewTextOf(parsed.document, evidence) };
}

/**
 * Publishes exactly this revision: it becomes the asset's current revision (and a held asset becomes
 * admitted), so discovery, navigation, series reads and the Universe see it from now on. Repeating it
 * changes nothing.
 */
function releaseRevision(
  db: Kysely<Database>,
  request: { readonly assetId: string; readonly revision: number; readonly decidedBy: string },
): Promise<ReleaseResult> {
  return withTransaction(db, 'content.review-release', async (trx): Promise<ReleaseResult> => {
    const asset = await lockAssetForReview(trx, request.assetId);
    const review = await lockReview(trx, request.assetId, request.revision);
    if (asset === undefined || asset.kind !== 'scroll') return { kind: 'refused', reason: 'not_under_review' };
    const decision = decideRelease({
      review: review?.state as ReviewState | undefined,
      assetStatus: asset.status === 'admitted' || asset.status === 'held' ? asset.status : 'withdrawn',
      servedRevision: asset.revision,
      revision: request.revision,
    });
    if (decision.kind === 'refused') return decision;
    const common = { assetId: request.assetId, revision: request.revision };
    if (decision.kind === 'already_released') return { kind: 'already_released', ...common, replacedRevision: null };
    await trx
      .updateTable('content.assets')
      .set({ revision: request.revision, status: 'admitted' })
      .where('id', '=', request.assetId)
      .execute();
    await trx
      .updateTable('content.revision_reviews')
      .set({ state: 'released', decided_at: sql`now()`, decided_by: request.decidedBy })
      .where('asset_id', '=', request.assetId)
      .where('revision', '=', request.revision)
      .execute();
    return { kind: 'released', ...common, replacedRevision: asset.status === 'admitted' ? asset.revision : null };
  });
}

/**
 * Keeps the revision out of the library for good and frees the recipe's next take. The asset keeps
 * serving whatever it served before; a new asset stays held. Repeating it keeps the first reason.
 */
async function rejectRevision(
  db: Kysely<Database>,
  request: {
    readonly assetId: string;
    readonly revision: number;
    readonly reason: string | undefined;
    readonly decidedBy: string;
  },
): Promise<RejectResult> {
  const reason = parseRejectReason(request.reason);
  if (reason === undefined) return { kind: 'refused', reason: 'reason_invalid' };
  return withTransaction(db, 'content.review-reject', async (trx): Promise<RejectResult> => {
    await lockAssetForReview(trx, request.assetId);
    const review = await lockReview(trx, request.assetId, request.revision);
    const decision = decideReject(review?.state as ReviewState | undefined);
    if (decision.kind === 'refused') return decision;
    const common = { assetId: request.assetId, revision: request.revision };
    if (decision.kind === 'already_rejected') return { kind: 'already_rejected', ...common };
    await trx
      .updateTable('content.revision_reviews')
      .set({ state: 'rejected', decided_at: sql`now()`, decided_by: request.decidedBy, reason })
      .where('asset_id', '=', request.assetId)
      .where('revision', '=', request.revision)
      .execute();
    return { kind: 'rejected', ...common };
  });
}

/**
 * The operator's review gate over the shared content tables (D-138): what is held, the text to read,
 * and the two decisions. Every decision is one short transaction under the asset's admission lock;
 * no model, network or personal root is involved. `decidedBy` is the operator's shell user
 * (`cli:<name>`), recorded with the time of the decision.
 */
export function makeReviewGate(db: Kysely<Database>) {
  return {
    list: (options: { readonly all: boolean }) => listRevisions(db, options),
    show: (request: Parameters<typeof showRevision>[1]) => showRevision(db, request),
    release: (request: Parameters<typeof releaseRevision>[1]) => releaseRevision(db, request),
    reject: (request: Parameters<typeof rejectRevision>[1]) => rejectRevision(db, request),
  };
}

export type ReviewGate = ReturnType<typeof makeReviewGate>;
