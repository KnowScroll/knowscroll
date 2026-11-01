import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadLibraryReels } from '../public.js';
import { topicIdsOf } from './library-passages.js';
import { notUnderReview } from './review-gate-sql.js';

/** The most Reels one read returns. */
const READ_LIMIT_MAX = 50;

interface Row {
  asset_id: string;
  revision: number;
  title: string;
  duration_ms: number;
}

/**
 * The library Reels under a topic (see `ReadLibraryReels`): the current revision of each admitted Reel whose primary encounter topic
 * is the topic, as the same rule that places a Scroll under a topic. A Reel marked as a fixture is never offered, and one whose stored
 * document is not a Reel document with a positive length is left out. Reads shared, immutable content in the caller's transaction.
 */
export const readLibraryReels: ReadLibraryReels = async (scope, topic, limit, only) => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_LIMIT_MAX) throw new Error('LIBRARY_REELS_LIMIT');
  const topicIds = topicIdsOf(topic);
  if (topicIds.length === 0) return [];
  const result =
    await sql<Row>`select r.asset_id, r.revision, r.title, (r.document ->> 'durationMs')::integer as duration_ms
    from content.assets a
    join content.asset_revisions r on r.asset_id = a.id and r.revision = a.revision
    where a.status = 'admitted' and a.kind = 'reel' and r.document_version = 'reel-document.v1'
      and coalesce((r.document ->> 'fixture')::boolean, false) = false
      and (r.document ->> 'durationMs') ~ '^[0-9]{4,7}$'
      and ${notUnderReview('r.asset_id', 'r.revision')}
      ${only === undefined ? sql`` : sql`and r.asset_id = ${only.assetId}::uuid`}
      and exists (select 1 from content.encounter_topics t where t.asset_id = r.asset_id
        and t.asset_revision = r.revision and t.role = 'primary' and t.topic_id = any(${topicIds}::text[]))
    order by r.title, r.asset_id limit ${limit}`.execute(transactionOf(scope));
  return result.rows.map((row) => ({
    assetId: row.asset_id,
    assetRevision: row.revision,
    title: row.title,
    durationMs: row.duration_ms,
  }));
};
