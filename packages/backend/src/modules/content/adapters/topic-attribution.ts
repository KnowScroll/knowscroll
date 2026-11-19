import type { Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { validateTopics } from '../domain/discovery.js';

/** The revision a recipe's planet is attributed to, and the basis the attribution records. */
export interface TopicAttribution {
  readonly assetId: string;
  readonly revision: number;
  readonly topicId: string;
  /** What the attribution rests on: a published model Scroll's recipe, or a hand-written Scroll's named recipe. */
  readonly version: string;
}

/**
 * Records the recipe's planet as the revision's single primary topic. The 0016 revision trigger already created the
 * baseline row; this never creates metadata for a missing revision or replaces conflicting authority. SQL's aggregate
 * weight guard stays active, and the row lock serializes even an idempotent projection of the same target. Returns
 * false when existing attribution conflicts. Runs only inside the admission or publication transaction of the revision
 * it attributes: there is no generic attribution API.
 */
export async function attributePrimaryTopic(tx: Transaction<Database>, target: TopicAttribution): Promise<boolean> {
  const metadata = await tx
    .selectFrom('content.discovery_revisions')
    .select('facets')
    .where('asset_id', '=', target.assetId)
    .where('asset_revision', '=', target.revision)
    .forUpdate()
    .executeTakeFirst();
  if (metadata === undefined) return false;
  const attribution = { topicId: target.topicId, role: 'primary' as const, weight: 1 };
  validateTopics([attribution]);
  const existing = await tx
    .selectFrom('content.encounter_topics')
    .select(['topic_id', 'role', 'weight'])
    .where('asset_id', '=', target.assetId)
    .where('asset_revision', '=', target.revision)
    .limit(17)
    .execute();
  if (
    (metadata.facets.length !== 0 && JSON.stringify(metadata.facets) !== JSON.stringify([attribution.topicId])) ||
    existing.length > 1 ||
    existing.some((entry) => entry.topic_id !== attribution.topicId || entry.role !== 'primary' || entry.weight !== 1)
  )
    return false;
  await tx
    .insertInto('content.encounter_topics')
    .values({
      asset_id: target.assetId,
      asset_revision: target.revision,
      topic_id: attribution.topicId,
      role: 'primary',
      weight: 1,
    })
    .onConflict((conflict) => conflict.columns(['asset_id', 'asset_revision', 'topic_id']).doNothing())
    .execute();
  await tx
    .updateTable('content.discovery_revisions')
    .set({ facets: [attribution.topicId], attribution_version: target.version })
    .where('asset_id', '=', target.assetId)
    .where('asset_revision', '=', target.revision)
    .execute();
  return true;
}
