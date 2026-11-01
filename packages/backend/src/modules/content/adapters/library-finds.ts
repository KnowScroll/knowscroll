import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { LibraryFindSource, ReadLibraryFinds } from '../public.js';
import { notUnderReview } from './review-gate-sql.js';
import { topicIdsOf } from './library-passages.js';

interface Row {
  asset_id: string;
  revision: number;
  kind: string;
  title: string;
  summary: string;
}

/** The most assets one read looks at. */
const READ_LIMIT_MAX = 100;

/**
 * The admitted library assets under a topic, newest first (see `ReadLibraryFinds`). An asset counts under a topic by the same
 * rule as the library's prose: the topic is its primary encounter topic. It is a Reel or a Scroll that is the asset's current
 * revision, is not held by the review gate and was not made for a thread, and has a summary to say something from. Reads the
 * pool outside any transaction: shared content, no person.
 */
export const makeReadLibraryFinds =
  (db: Kysely<Database>): ReadLibraryFinds =>
  async (topic, limit, only) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > READ_LIMIT_MAX) throw new Error('LIBRARY_FINDS_LIMIT');
    const topicIds = topicIdsOf(topic);
    if (topicIds.length === 0) return [];
    const result = await sql<Row>`select a.id as asset_id, a.revision, a.kind, r.title, d.summary
      from content.assets a
      join content.asset_revisions r on r.asset_id = a.id and r.revision = a.revision
      join content.discovery_revisions d on d.asset_id = r.asset_id and d.asset_revision = r.revision
      where a.status = 'admitted' and a.kind in ('reel', 'scroll') and d.summary <> ''
        and not exists (select 1 from content.made_to_order_scrolls o where o.asset_id = r.asset_id)
        and ${notUnderReview('r.asset_id', 'r.revision')}
        ${only === undefined ? sql`` : sql`and a.id = ${only.assetId}::uuid and a.revision = ${only.assetRevision}`}
        and exists (select 1 from content.encounter_topics t where t.asset_id = r.asset_id
          and t.asset_revision = r.revision and t.role = 'primary' and t.topic_id = any(${topicIds}::text[]))
      order by a.created_at desc, a.id limit ${limit}`.execute(db);
    return result.rows.flatMap((row): LibraryFindSource[] =>
      row.kind === 'reel' || row.kind === 'scroll'
        ? [
            {
              assetId: row.asset_id,
              assetRevision: row.revision,
              kind: row.kind,
              title: row.title,
              summary: row.summary,
            },
          ]
        : [],
    );
  };
