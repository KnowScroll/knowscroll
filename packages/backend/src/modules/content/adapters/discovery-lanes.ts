import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';
import {
  DISCOVERY_LANE_QUOTAS,
  siblingTopicIds,
  topicSystemPairs,
  type DiscoveryLane,
  type DiscoveryLanes,
} from '../domain/discovery-lanes.js';
import { distance, notOrdered, rotationCursor } from './discovery-sql.js';
import type { ReadDiscoveryCandidates } from '../public.js';
import type { CatalogueSnapshot } from '../domain/catalogue/snapshot.js';

type Query = Parameters<ReadDiscoveryCandidates>[1];
type Band = 0 | 1;

/** One candidate of a lane-based read: the asset, and the lane that read it first. */
export interface LaneRow {
  readonly assetId: string;
  readonly lane: DiscoveryLane;
}

/**
 * Lane priorities. A candidate read by several lanes keeps the first of these, and the read is ordered by band (the person's
 * unseen explanations first), then priority, then the lane's own rank, then the stable random key from the cursor.
 */
const PRIORITY: Readonly<Record<DiscoveryLane, number>> = {
  source: 0,
  planned: 1,
  text: 2,
  continue: 3,
  adjacent: 4,
  explore: 5,
};

const current = sql`join content.assets a on a.id=r.asset_id and a.revision=r.revision`;
const discovery = sql`join content.discovery_revisions d on d.asset_id=r.asset_id and d.asset_revision=r.revision`;

/** Admitted, renderable-kind candidates in the person's languages; with a met list, only the explanations not in it (the unseen band). */
function eligibleOf(q: Query, metUnitIds: readonly string[] | undefined) {
  const unseenOnly = metUnitIds === undefined ? sql`` : sql`and r.explanation_unit_id <> all(${metUnitIds}::text[])`;
  return sql`a.status='admitted' and ${notOrdered} and r.language=any(${q.languages}::text[]) and a.kind=any(${q.formats}::text[]) ${unseenOnly}`;
}

/** The topics of the encounter the person is on, or the sibling topics: primary before supporting, then the rotation. */
function topicLane(
  lane: 'source' | 'adjacent',
  topicIds: readonly string[],
  limit: number,
  cursor: number,
  band: Band,
  eligible: ReturnType<typeof sql>,
) {
  if (topicIds.length === 0) return sql``;
  return sql`union all
    (select asset_id,${sql.lit(band)} as band,${sql.lit(PRIORITY[lane])} as priority,min(role_rank) as role_rank,min(rot) as rot,${sql.lit(lane)}::text as lane from (
      select r.asset_id,(t.role='supporting')::int as role_rank,${distance(sql`d.serve_rand`, cursor)} as rot
      from content.encounter_topics t join content.asset_revisions r on r.asset_id=t.asset_id and r.revision=t.asset_revision ${current}
      ${discovery}
      where ${eligible} and t.role in ('primary','supporting') and t.topic_id=any(${topicIds}::text[])) in_topics
     group by asset_id order by min(role_rank),min(rot) limit ${limit})`;
}

/** The units a valid Planner opportunity names, in the rotation. */
function plannedLane(unitIds: readonly string[], cursor: number, band: Band, eligible: ReturnType<typeof sql>) {
  if (unitIds.length === 0) return sql``;
  return sql`union all
    (select r.asset_id,${sql.lit(band)} as band,${sql.lit(PRIORITY.planned)} as priority,0 as role_rank,${distance(sql`d.serve_rand`, cursor)} as rot,'planned'::text as lane
      from content.asset_revisions r ${current} ${discovery}
      where ${eligible} and r.explanation_unit_id=any(${unitIds}::text[]) order by rot limit ${DISCOVERY_LANE_QUOTAS.planned})`;
}

/** What the person typed, matched against the library's search text (never a source's own summary). */
function textLane(text: string, cursor: number, band: Band, eligible: ReturnType<typeof sql>) {
  if (text === '') return sql``;
  return sql`union all
    (select r.asset_id,${sql.lit(band)} as band,${sql.lit(PRIORITY.text)} as priority,0 as role_rank,${distance(sql`d.serve_rand`, cursor)} as rot,'text'::text as lane
      from content.discovery_revisions d join content.asset_revisions r on r.asset_id=d.asset_id and r.revision=d.asset_revision ${current}
      where ${eligible} and d.search_text@@plainto_tsquery('simple',${text}) order by rot limit ${DISCOVERY_LANE_QUOTAS.text})`;
}

/**
 * The person's top interest topics, at most `continuePerSystem` candidates of any one system. Topics arrive strongest first, so a
 * candidate ranks by the strongest topic it is about, and the quota is applied per system after that ranking: a person whose
 * interest is mostly one system still gets candidates from their other systems.
 */
function continueLane(
  catalogue: CatalogueSnapshot,
  topicIds: readonly string[],
  cursor: number,
  band: Band,
  eligible: ReturnType<typeof sql>,
) {
  if (topicIds.length === 0) return sql``;
  const systemIds = topicIds.map((id) => catalogue.systemOf(id) ?? id);
  return sql`union all
    (select asset_id,${sql.lit(band)} as band,${sql.lit(PRIORITY.continue)} as priority,topic_rank as role_rank,rot,'continue'::text as lane from (
      select asset_id,topic_rank,rot,row_number() over (partition by system_id order by topic_rank,rot) as in_system from (
        select r.asset_id,c.system_id,min(c.rank)::int as topic_rank,min(${distance(sql`d.serve_rand`, cursor)}) as rot
        from unnest(${topicIds}::text[],${systemIds}::text[]) with ordinality as c(topic_id,system_id,rank)
        join content.encounter_topics t on t.topic_id=c.topic_id and t.role in ('primary','supporting')
        join content.asset_revisions r on r.asset_id=t.asset_id and r.revision=t.asset_revision ${current}
        ${discovery}
        where ${eligible}
        group by r.asset_id,c.system_id) per_system) ranked
     where in_system<=${DISCOVERY_LANE_QUOTAS.continuePerSystem} order by topic_rank,rot limit ${DISCOVERY_LANE_QUOTAS.continue})`;
}

/**
 * A rotating sample of the whole library, stratified by system. The rows come from two index range scans of `serve_rand` (from
 * the cursor to the end, then from the start to the cursor), so the read is cheap however large the library is; each row is
 * put in the system of its heaviest primary topic (a topic the catalogue does not hold is its own stratum) and the lane takes
 * them round-robin: the first of every system, then the second of every system, and so on. It is last in priority, so the cap of
 * the whole read trims it and it takes whatever the other lanes leave.
 */
function exploreLane(catalogue: CatalogueSnapshot, cursor: number, band: Band, eligible: ReturnType<typeof sql>) {
  const { topicIds, systemIds } = topicSystemPairs(catalogue);
  const window = DISCOVERY_LANE_QUOTAS.exploreWindow;
  const side = (condition: ReturnType<typeof sql>) => sql`
      (select r.asset_id,r.revision as asset_revision,${distance(sql`d.serve_rand`, cursor)} as rot
        from content.discovery_revisions d join content.asset_revisions r on r.asset_id=d.asset_id and r.revision=d.asset_revision ${current}
        where ${condition} and ${eligible} order by d.serve_rand limit ${window})`;
  return sql`union all
    (select asset_id,${sql.lit(band)} as band,${sql.lit(PRIORITY.explore)} as priority,in_system as role_rank,rot,'explore'::text as lane from (
      select asset_id,rot,(row_number() over (partition by stratum order by rot))::int as in_system from (
        select w.asset_id,w.rot,coalesce(m.system_id,lead_topic.topic_id,'') as stratum
        from (${side(sql`d.serve_rand>=${cursor}::float8`)} union all ${side(sql`d.serve_rand<${cursor}::float8`)}) w
        left join lateral (select t.topic_id from content.encounter_topics t
          where t.asset_id=w.asset_id and t.asset_revision=w.asset_revision and t.role='primary' order by t.weight desc,t.topic_id limit 1) lead_topic on true
        left join unnest(${topicIds}::text[],${systemIds}::text[]) as m(topic_id,system_id) on m.topic_id=lead_topic.topic_id) strata) ranked
     order by in_system,rot limit ${DISCOVERY_LANE_QUOTAS.explore})`;
}

/** The first lane of a read: the source's topics, or an empty select when there are none, so every other lane can be `union all`. */
const nothing = sql`select null::uuid as asset_id,0 as band,0 as priority,0 as role_rank,0::float8 as rot,'source'::text as lane where false`;

/** The rows of every lane in one band: band 0 the person's unseen explanations, band 1 everything. */
function laneRows(
  q: Query,
  lanes: DiscoveryLanes,
  cursor: number,
  band: Band,
  metUnitIds: readonly string[] | undefined,
) {
  const eligible = eligibleOf(q, metUnitIds);
  const sourceTopics = q.topicIds ?? [];
  return sql`(${nothing})
    ${topicLane('source', sourceTopics, DISCOVERY_LANE_QUOTAS.source, cursor, band, eligible)}
    ${plannedLane(lanes.plannedUnitIds, cursor, band, eligible)}
    ${textLane((q.text ?? '').trim(), cursor, band, eligible)}
    ${continueLane(lanes.catalogue, lanes.continueTopicIds, cursor, band, eligible)}
    ${topicLane('adjacent', siblingTopicIds(lanes.catalogue, sourceTopics), DISCOVERY_LANE_QUOTAS.adjacent, cursor, band, eligible)}
    ${exploreLane(lanes.catalogue, cursor, band, eligible)}`;
}

/**
 * The asset ids of a lane-based read with the lane that read each, in the order the candidates are read (policy v3, D-420):
 * the person's unseen explanations before any other (the unseen-first bands of D-408), then lane priority, then each lane's
 * rank, then the stable random order from the decision's cursor. `alwaysUnits` (the source's own unit, so its format twin is
 * found) come before all of them. An asset read by several lanes keeps the first lane.
 */
export async function laneAssetIds(
  db: Kysely<Database>,
  q: Query,
  lanes: DiscoveryLanes,
  metUnitIds: readonly string[] | undefined,
): Promise<readonly LaneRow[]> {
  const cursor = rotationCursor(q.rotation);
  const always = q.alwaysUnits ?? [];
  const alwaysLane = always.length
    ? sql`union all
    (select r.asset_id,-1 as band,0 as priority,0 as role_rank,0::float8 as rot,'source'::text as lane
      from content.asset_revisions r join content.assets a on a.id=r.asset_id and a.revision=r.revision
      where a.status='admitted' and ${notOrdered} and r.language=any(${q.languages}::text[]) and a.kind=any(${q.formats}::text[])
        and r.explanation_unit_id=any(${always}::text[]) limit 4)`
    : sql``;
  const unseenBand = metUnitIds === undefined ? sql`` : sql`union all ${laneRows(q, lanes, cursor, 0, metUnitIds)}`;
  const ids = await sql<{ asset_id: string; lane: DiscoveryLane }>`select asset_id,lane from (
    select distinct on (asset_id) asset_id,lane,band,priority,role_rank,rot from (
      ${laneRows(q, lanes, cursor, 1, undefined)}
      ${unseenBand}
      ${alwaysLane}
    ) every_lane order by asset_id,band,priority,role_rank,rot) best
    order by band,priority,role_rank,rot,asset_id limit 100`.execute(db);
  return ids.rows.map((row) => ({ assetId: row.asset_id, lane: row.lane }));
}
