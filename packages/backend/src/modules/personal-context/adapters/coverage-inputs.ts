import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ReadCoverageInputs } from '../public.js';
import { readContextRevision } from './postgres-store.js';

/** Topic ids one read may name: a neighbour read names the children of one system. */
const MAX_TOPICS_NAMED = 1000;
/** The pages of a facet's keys a consumer may walk: 0 is the newest. */
const MAX_PAGE = 64;

/**
 * Candidate probes for named topics only (#674, D-416). `coverage_supports` holds one row per support key however many
 * exposures reference it, so re-reading adds references and never keys: a heavy reader's cost is the topics read and the
 * library's units under them, never how much they have read. Per facet only the newest `perFacet` keys are returned
 * (`last_activated_at`, then unit id), which is what the formation rules need: the newest support of each facet decides a
 * region and a place's last activity, and a planet needs three distinct units over two facets. A consumer that finds none of a
 * facet's newest keys trusted asks for the next `page` of just that facet (`onlyFacets`), so a withdrawn newest key never
 * hides an older trusted one. With `maxTopics`, the topics that have a key are taken newest first (the topic whose newest key
 * is the most recent), so a few of a system's topics hold its latest support. With `recent` the topics are the most recently
 * supported ones the person has, other than the ones excluded, so a consumer can sample what else they read.
 *
 * Candidate discovery only. The current trusted read must fence every actual apply.
 */
export const readCoverageInputs: ReadCoverageInputs = async (scope, query) => {
  const page = query.page ?? 0;
  if (
    (query.topicIds?.length ?? 0) > MAX_TOPICS_NAMED ||
    !Number.isInteger(query.perFacet) ||
    query.perFacet < 1 ||
    !Number.isInteger(page) ||
    page < 0 ||
    page > MAX_PAGE ||
    (query.topicIds === undefined) === (query.recent === undefined)
  )
    throw new Error('PERSONAL_COVERAGE_INPUTS_QUERY');
  const { revision } = await readContextRevision(scope);
  const u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  if (query.topicIds && !query.topicIds.length) return { revision, topics: [], probes: [] };
  const maxTopics = query.recent ? query.recent.limit : (query.maxTopics ?? MAX_TOPICS_NAMED);
  const named = query.recent
    ? sql`select topic_id from personal_context.coverage_supports
        where universe_id=${u}::uuid and privacy_epoch=${e} and not (topic_id=any(${[...query.recent.exclude]}::text[]))
        group by topic_id order by max(last_activated_at) desc nulls last,topic_id limit ${maxTopics}`
    : sql`select topic_id from personal_context.coverage_supports
        where universe_id=${u}::uuid and privacy_epoch=${e} and topic_id=any(${[...(query.topicIds ?? [])]}::text[])
        group by topic_id order by max(last_activated_at) desc nulls last,topic_id limit ${maxTopics}`;
  const only = query.onlyFacets
    ? sql`and (s.topic_id,s.facet_id) in (select * from unnest(${query.onlyFacets.map((f) => f.topicId)}::text[],${query.onlyFacets.map((f) => f.facetId)}::text[]))`
    : sql``;
  const rows = await sql<{
    topicId: string;
    facetId: string;
    explanationUnitId: string;
  }>`with named as (${named}),
    keys as (
      select s.topic_id,s.facet_id,s.explanation_unit_id,max(s.last_activated_at) as at
      from personal_context.coverage_supports s join named using(topic_id)
      where s.universe_id=${u}::uuid and s.privacy_epoch=${e} ${only}
      group by s.topic_id,s.facet_id,s.explanation_unit_id),
    ranked as (
      select keys.*,row_number() over (partition by topic_id,facet_id order by at desc nulls last,explanation_unit_id) as place
      from keys)
    select topic_id as "topicId",facet_id as "facetId",explanation_unit_id as "explanationUnitId"
    from ranked where place>${page * query.perFacet} and place<=${(page + 1) * query.perFacet}
    order by topic_id,facet_id,place`.execute(transactionOf(scope));
  const topics = query.onlyFacets
    ? [...new Set(rows.rows.map((row) => row.topicId))]
    : (
        await sql<{ topic_id: string }>`with named as (${named}) select topic_id from named order by topic_id`.execute(
          transactionOf(scope),
        )
      ).rows.map((row) => row.topic_id);
  return { revision, topics, probes: rows.rows };
};
