import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadCoverageInputs } from '../public.js';
import { readContextRevision } from './postgres-store.js';

/** Topic ids one read may name: a neighbour read names the children of one system. */
const MAX_TOPICS_NAMED = 1000;

/**
 * Candidate probes for named topics only (#674, D-416). With `maxTopics`, the topics that have a key are taken newest first (the
 * topic whose newest key is the most recent), so a few of a system's topics hold its latest support. `coverage_supports` holds one row per support key however many
 * exposures reference it, so re-reading adds references and never keys: a heavy reader's cost is the topics read and the
 * library's units under them, never how much they have read. Per facet only the newest `perFacet` keys are returned
 * (`last_activated_at`, then unit id), which is what the formation rules need: the newest support of each facet decides a
 * region and a place's last activity, and a planet needs three distinct units over two facets.
 *
 * Candidate discovery only. The current trusted read must fence every actual apply.
 */
export const readCoverageInputs: ReadCoverageInputs = async (scope, query) => {
  if (query.topicIds.length > MAX_TOPICS_NAMED || !Number.isInteger(query.perFacet) || query.perFacet < 1)
    throw new Error('PERSONAL_COVERAGE_INPUTS_QUERY');
  const { revision } = await readContextRevision(scope);
  if (!query.topicIds.length) return { revision, topics: [], probes: [] };
  const maxTopics = query.maxTopics ?? MAX_TOPICS_NAMED;
  const rows = await sql<{
    topicId: string;
    facetId: string;
    explanationUnitId: string;
  }>`with named as (
      select topic_id from personal_context.coverage_supports
      where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}
        and topic_id=any(${[...query.topicIds]}::text[])
      group by topic_id order by max(last_activated_at) desc nulls last,topic_id limit ${maxTopics}),
    keys as (
      select s.topic_id,s.facet_id,s.explanation_unit_id,max(s.last_activated_at) as at
      from personal_context.coverage_supports s join named using(topic_id)
      where s.universe_id=${scope.authority.universeId}::uuid and s.privacy_epoch=${scope.authority.privacyEpoch}
      group by s.topic_id,s.facet_id,s.explanation_unit_id),
    ranked as (
      select keys.*,row_number() over (partition by topic_id,facet_id order by at desc nulls last,explanation_unit_id) as place
      from keys)
    select topic_id as "topicId",facet_id as "facetId",explanation_unit_id as "explanationUnitId"
    from ranked where place<=${query.perFacet} order by topic_id,facet_id,place`.execute(transactionOf(scope));
  return { revision, topics: [...new Set(rows.rows.map((row) => row.topicId))], probes: rows.rows };
};
