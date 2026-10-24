import { sql, type Kysely } from 'kysely';
import type { z } from 'zod';
import type { ConversationContentProjectionSchema } from '@knowscroll/contracts';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ContentRef, ReadPublicContent, ReadShareableContent } from '../public.js';

interface Row {
  assetId: string;
  assetRevision: number;
  status: string | null;
  current_revision: number | null;
  kind: 'reel' | 'scroll' | null;
  title: string | null;
  summary: string | null;
  language: string | null;
  current_title: string | null;
  current_summary: string | null;
  current_language: string | null;
}

type Projection = z.infer<typeof ConversationContentProjectionSchema>;

/**
 * The public metadata of exact content revisions, for cards in conversations and for share links.
 * It reads shared, immutable content and states what exists now, never who may see it: callers
 * decide access.
 *
 * Per ref: `available` (the revision is the current admitted one), `corrected` (admitted, but a
 * newer revision exists; both revisions' metadata are returned, the original ref is kept) or
 * `unavailable` (withdrawn, missing, or lacking a published summary). Input is limited to 100 refs.
 */
async function readMetadata(reader: Kysely<Database>, refs: readonly ContentRef[]): Promise<Projection[]> {
  if (refs.length > 100) throw new Error('SHAREABLE_CONTENT_LIMIT');
  if (refs.length === 0) return [];
  const result = await sql<Row>`
    select x."assetId", x."assetRevision", a.status, a.revision as current_revision, a.kind,
      r.title, d.summary, r.language,
      rc.title as current_title, dc.summary as current_summary, rc.language as current_language
    from jsonb_to_recordset(${JSON.stringify(refs)}::jsonb) as x("assetId" uuid, "assetRevision" integer)
    left join content.assets a on a.id = x."assetId"
    left join content.asset_revisions r on r.asset_id = x."assetId" and r.revision = x."assetRevision"
    left join content.discovery_revisions d on d.asset_id = r.asset_id and d.asset_revision = r.revision
    left join content.asset_revisions rc on rc.asset_id = a.id and rc.revision = a.revision
    left join content.discovery_revisions dc on dc.asset_id = rc.asset_id and dc.asset_revision = rc.revision`.execute(
    reader,
  );
  return refs.map((ref) =>
    project(
      ref,
      result.rows.find((row) => row.assetId === ref.assetId && row.assetRevision === ref.assetRevision),
    ),
  );
}

/** Inside a personal transaction (the same transaction a pair-locked shared scope uses). */
export const readShareableContent: ReadShareableContent = (scope, refs) => readMetadata(transactionOf(scope), refs);

/** For visitors with no account: reads on the pool, bound once by the composition root. */
export const makeReadPublicContent =
  (db: Kysely<Database>): ReadPublicContent =>
  (refs) =>
    readMetadata(db, refs);

function project(target: ContentRef, row: Row | undefined): Projection {
  const unavailable: Projection = { status: 'unavailable', target };
  if (row?.status !== 'admitted' || row.kind === null) return unavailable;
  if (row.title === null || row.summary === null || row.language === null) return unavailable;
  const metadata = { kind: row.kind, title: row.title, summary: row.summary, language: row.language };
  if (row.current_revision === target.assetRevision) return { status: 'available', target, metadata };
  if (
    row.current_revision === null ||
    row.current_title === null ||
    row.current_summary === null ||
    row.current_language === null
  )
    return unavailable;
  return {
    status: 'corrected',
    target,
    current: {
      assetId: target.assetId,
      assetRevision: row.current_revision,
      metadata: {
        kind: row.kind,
        title: row.current_title,
        summary: row.current_summary,
        language: row.current_language,
      },
    },
  };
}
