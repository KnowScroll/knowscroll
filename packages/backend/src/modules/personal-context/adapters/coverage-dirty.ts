import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ClearCoverageDirty, MarkCoverageDirty, ReadCoverageDirty } from '../application/coverage-ports.js';
import { markTopicsDirty } from './coverage-store.js';
import { readContextRevision } from './postgres-store.js';

/** The most topics one read returns; Geography takes one number from its own policy, below this. */
const MAX_DIRTY_LIMIT = 64;

/**
 * The newest dirty topics of the caller (#674, D-416), through the index on (universe, epoch, revision, topic): what was read
 * last is placed first, and a backlog marked by the operator waits behind it. One extra row says whether more remain.
 * Reads nothing of the support itself.
 */
export const readCoverageDirty: ReadCoverageDirty = async (scope, { limit }) => {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DIRTY_LIMIT)
    throw new Error('PERSONAL_COVERAGE_DIRTY_LIMIT');
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  const { revision } = await readContextRevision(scope);
  const dirty = await sql<{ topic_id: string }>`select topic_id from personal_context.coverage_dirty_topics
    where universe_id=${u}::uuid and privacy_epoch=${e} order by dirty_revision desc,topic_id limit ${limit + 1}`.execute(
    db,
  );
  const anySupport =
    dirty.rows.length > 0 ||
    (
      await sql`select 1 from personal_context.coverage_supports
        where universe_id=${u}::uuid and privacy_epoch=${e} limit 1`.execute(db)
    ).rows.length > 0;
  return {
    revision,
    topics: dirty.rows.slice(0, limit).map((row) => row.topic_id),
    hasMore: dirty.rows.length > limit,
    anySupport,
  };
};

/** Deletes what a run evaluated, and only what it had seen: a row marked after the read has a higher revision. */
export const clearCoverageDirty: ClearCoverageDirty = async (scope, { topicIds, throughRevision }) => {
  if (!topicIds.length) return 0;
  const result = await sql`delete from personal_context.coverage_dirty_topics
    where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
      and topic_id=any(${[...topicIds]}::text[]) and dirty_revision<=${throughRevision}`.execute(transactionOf(scope));
  return Number(result.numAffectedRows ?? 0);
};

/** Every topic the caller holds a support key under, marked dirty at the revision this transaction commits at. */
export const markCoverageDirty: MarkCoverageDirty = async (scope) => {
  const topics = await sql<{ topic_id: string }>`select distinct topic_id from personal_context.coverage_supports
    where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}`.execute(
    transactionOf(scope),
  );
  return markTopicsDirty(
    scope,
    topics.rows.map((row) => row.topic_id),
  );
};
