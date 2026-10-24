import { createHash, randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import { ReelDocumentSchema } from '@knowscroll/contracts';
import type { Database } from '../../../../infrastructure/postgres/database.js';
import { withTransaction } from '../../../../infrastructure/postgres/personal-scope.js';
import { validateTopics } from '../../domain/discovery.js';
import type { PublishReel, PublishResult, ReelPublisher } from '../../application/reel/ports.js';

const ATTRIBUTION_VERSION = 'reel-twin-taxonomy.v1';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The reading facts a Reel carries: its duration, no blocks (same shape as the three v1 Reels). */
const readingFactsOf = (durationMs: number) => ({
  v: 2,
  measuresVersion: 'reel-duration.v1',
  totalWeight: 0,
  estimatedReadingMs: durationMs,
  blocks: [],
  nested: [],
  reelDurationMs: durationMs,
});

async function twinStillAdmitted(trx: Transaction<Database>, reel: PublishReel): Promise<boolean> {
  const { rows } = await sql`select 1 from content.assets a
    join content.asset_revisions r on r.asset_id = a.id and r.revision = a.revision
    where a.id = ${reel.twin.assetId}::uuid and a.kind = 'scroll' and a.status = 'admitted'
      and a.revision = ${reel.twin.revision} and r.explanation_unit_id = ${reel.twin.explanationUnitId}`.execute(trx);
  return rows.length === 1;
}

async function insertMedia(trx: Transaction<Database>, reel: PublishReel): Promise<string> {
  const { media } = reel;
  await sql`insert into content.media_objects (id, logical_key, backend, sha256, size_bytes, mime, probe)
    values (${randomUUID()}::uuid, ${media.key}, 'local', ${media.sha256}, ${media.size}, 'video/mp4', ${JSON.stringify(media.probe)}::jsonb)
    on conflict (sha256) do nothing`.execute(trx);
  const { rows } = await sql<{
    id: string;
  }>`select id from content.media_objects where sha256 = ${media.sha256}`.execute(trx);
  return rows[0]!.id;
}

async function insertAsset(trx: Transaction<Database>, reel: PublishReel, mediaId: string): Promise<void> {
  const assetId = reel.script.id;
  const { brief } = reel.script;
  const document = ReelDocumentSchema.parse({
    schemaVersion: 'reel-document.v1',
    assetId,
    revision: 1,
    title: brief.title,
    summary: brief.summary,
    language: 'en',
    truthLabel: 'generated',
    fixture: false,
    captions: 'burned_in',
    mediaKey: reel.media.key,
    durationMs: reel.media.probe.durationMs,
    width: reel.media.probe.width,
    height: reel.media.probe.height,
  });
  await trx
    .insertInto('content.assets')
    .values({ id: assetId, revision: 1, kind: 'reel', status: 'admitted' })
    .execute();
  await trx
    .insertInto('content.asset_revisions')
    .values({
      asset_id: assetId,
      revision: 1,
      provenance_kind: 'cutroom_import',
      document_version: 'reel-document.v1',
      document: JSON.stringify(document),
      document_sha256: sha256(JSON.stringify(document)),
      explanation_unit_id: reel.twin.explanationUnitId,
      language: 'en',
      title: brief.title,
      reading_facts: JSON.stringify(readingFactsOf(reel.media.probe.durationMs)),
    })
    .execute();
  await trx
    .insertInto('content.asset_provenance')
    .values({
      asset_id: assetId,
      revision: 1,
      provenance_version: 'reel-provenance.v1',
      provenance: JSON.stringify(reel.provenance),
    })
    .execute();
  await sql`insert into content.reel_imports (run_id, asset_id, asset_revision, media_id, script_name, fixture)
    values (${reel.runId}::uuid, ${assetId}::uuid, 1, ${mediaId}::uuid, ${reel.scriptName}, false)`.execute(trx);
}

/** The twin's planet becomes the Reel's single primary topic, as it is for the Scroll. */
async function attributeTopic(trx: Transaction<Database>, reel: PublishReel): Promise<void> {
  validateTopics([{ topicId: reel.topicId, role: 'primary', weight: 1 }]);
  const assetId = reel.script.id;
  await sql`select 1 from content.discovery_revisions where asset_id = ${assetId}::uuid and asset_revision = 1 for update`.execute(
    trx,
  );
  await sql`insert into content.encounter_topics (asset_id, asset_revision, topic_id, role, weight)
    values (${assetId}::uuid, 1, ${reel.topicId}, 'primary', 1) on conflict do nothing`.execute(trx);
  await sql`update content.discovery_revisions set facets = ${[reel.topicId]}::text[], attribution_version = ${ATTRIBUTION_VERSION}
    where asset_id = ${assetId}::uuid and asset_revision = 1`.execute(trx);
}

async function markOrder(trx: Transaction<Database>, orderId: string, assetId: string): Promise<void> {
  await sql`update content.reel_orders set asset_id = ${assetId}::uuid, published_at = clock_timestamp()
    where id = ${orderId}::uuid and asset_id is null`.execute(trx);
}

/**
 * Admits a Reel as revision 1 of the script's asset, in the twin's explanation unit and planet.
 * One short transaction; the media is already installed and nothing is awaited inside it. The
 * Cutroom run id is the import's key, so the same run publishes once and a second run for the same
 * asset is refused.
 */
export function postgresReelPublisher(db: Kysely<Database>): ReelPublisher {
  return {
    async publish(reel): Promise<PublishResult> {
      const assetId = reel.script.id;
      // Cutroom's run ids are UUIDs; the import table keys on one.
      if (!uuidPattern.test(reel.runId)) return { kind: 'refused', code: 'run_id_not_uuid' };
      return withTransaction(db, 'content.reel-publication', async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtextextended(${`content.asset:${assetId}`}, 0))`.execute(trx);
        const earlier = await sql<{
          asset_id: string;
        }>`select asset_id from content.reel_imports where run_id = ${reel.runId}::uuid`.execute(trx);
        if (earlier.rows[0] !== undefined) {
          if (reel.orderId !== undefined) await markOrder(trx, reel.orderId, assetId);
          return { kind: 'published', assetId, created: false };
        }
        const exists = await trx.selectFrom('content.assets').select('id').where('id', '=', assetId).executeTakeFirst();
        if (exists !== undefined) return { kind: 'refused', code: 'asset_exists_for_other_run' };
        if (!(await twinStillAdmitted(trx, reel))) return { kind: 'refused', code: 'twin_changed' };
        await insertAsset(trx, reel, await insertMedia(trx, reel));
        await attributeTopic(trx, reel);
        if (reel.orderId !== undefined) await markOrder(trx, reel.orderId, assetId);
        return { kind: 'published', assetId, created: true };
      });
    },
  };
}
