import type { ReadEncounterAttribution, ReadPlayLevel } from '../public.js';
import { traitsOfDocument } from '../domain/traits.js';
import { createHash } from 'node:crypto';
import { ClientCapabilities, ReelDocumentSchema } from '@knowscroll/contracts';
import { sql, type Kysely } from 'kysely';
import { SCROLL_DOCUMENT_SCHEMA_VERSION } from '@knowscroll/scroll-model';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { canRenderScroll, isScrollDocumentV2 } from './render-scroll.js';
import { notUnderReview } from './review-gate-sql.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import {
  DISCOVERY_MAX_TOPICS,
  validateTopics,
  validateUnseenFirst,
  type EncounterSnapshot,
  type ReadDiscoveryCandidates,
  type ReadExactEncounter,
  type ReadContinuations,
  type ResolveContinuityLink,
  type ReadEncounterTopics,
  type ReadSavedMetadata,
  type ReadSavedPageMetadata,
  type ContinuityLink,
} from '../public.js';
type Row = {
  asset_id: string;
  asset_revision: number;
  kind: 'reel' | 'scroll';
  explanation_unit_id: string;
  title: string;
  summary: string;
  language: string;
  facets: string[];
  attribution_version: string;
  document_sha256: string;
  document: unknown;
  topics: EncounterSnapshot['topics'];
  siblings: EncounterSnapshot['siblings'];
  series: (NonNullable<EncounterSnapshot['series']> & { total: number }) | null;
};
function canRender(row: Row, capabilities: unknown): boolean {
  if (row.kind === 'reel') {
    const c = ClientCapabilities.safeParse(capabilities);
    return (
      c.success &&
      c.data.documentSchemas.includes('reel-document.v1') &&
      ReelDocumentSchema.safeParse(row.document).success
    );
  }
  return canRenderScroll(row.document, capabilities);
}
/**
 * The latest earlier v1 revision of each asset whose current revision is a v2 document the client
 * cannot render. A regenerated Scroll keeps its asset, so the v1 revision it replaced is the fallback
 * for a client that has not learned v2; an asset with none is simply not offered to that client.
 */
async function olderV1Rows(db: Kysely<Database>, assetIds: readonly string[]): Promise<ReadonlyMap<string, Row>> {
  if (assetIds.length === 0) return new Map();
  const found = await sql<{ asset_id: string; revision: number }>`select distinct on (r.asset_id) r.asset_id,r.revision
    from content.asset_revisions r join content.assets a on a.id=r.asset_id and a.status='admitted'
    where r.asset_id=any(${assetIds}::uuid[]) and r.document_version=${SCROLL_DOCUMENT_SCHEMA_VERSION} and r.revision<a.revision
    order by r.asset_id,r.revision desc`.execute(db);
  if (found.rows.length === 0) return new Map();
  const pairs = sql.join(found.rows.map((row) => sql`(${row.asset_id}::uuid,${row.revision})`));
  const older = await rows(db, sql`(r.asset_id,r.revision) in (${pairs})`, 100);
  return new Map(older.map((row) => [row.asset_id, row]));
}
function snapshot(row: Row): EncounterSnapshot {
  validateTopics(row.topics);
  const series = row.series
    ? { seriesId: row.series.seriesId, seriesRevision: row.series.seriesRevision, part: row.series.part }
    : undefined;
  const seriesTotal = row.series?.total ?? 0;
  return {
    assetId: row.asset_id,
    assetRevision: row.asset_revision,
    kind: row.kind,
    explanationUnitId: row.explanation_unit_id,
    metadata: { kind: row.kind, title: row.title, summary: row.summary, language: row.language },
    topics: row.topics,
    facets: row.facets,
    siblings: row.siblings,
    ...(series ? { series } : {}),
    traits: { ...traitsOfDocument(row.document), ...(seriesTotal > 0 ? { seriesTotal } : {}) },
    catalogWatermark: createHash('sha256')
      .update(
        JSON.stringify([
          row.document_sha256,
          row.attribution_version,
          row.topics.map((t) => [t.topicId, t.role, t.weight]),
          row.facets,
          row.siblings.map((s) => [s.assetId, s.assetRevision, s.kind]),
          series ? [series.seriesId, series.seriesRevision, series.part] : null,
        ]),
      )
      .digest('hex'),
    attributionVersion: row.attribution_version,
  };
}
/** One bounded join, no provenance or personal history; exact lookup may read an older admitted revision. */
async function rows(db: Kysely<Database>, filter: ReturnType<typeof sql>, limit: number): Promise<readonly Row[]> {
  const result =
    await sql<Row>`select r.asset_id,r.revision as asset_revision,a.kind,r.explanation_unit_id,r.title,d.summary,r.language,d.facets,d.attribution_version,r.document_sha256,r.document,
    coalesce((select jsonb_agg(jsonb_build_object('topicId',t.topic_id,'role',t.role,'weight',t.weight) order by t.topic_id) from content.encounter_topics t where t.asset_id=r.asset_id and t.asset_revision=r.revision),'[]') as topics,
    coalesce((select jsonb_agg(s.value order by s.kind) from (select distinct on (aa.kind) aa.kind,jsonb_build_object('assetId',rr.asset_id,'assetRevision',rr.revision,'kind',aa.kind) as value from content.asset_revisions rr join content.assets aa on aa.id=rr.asset_id and aa.revision=rr.revision and aa.status='admitted' where rr.explanation_unit_id=r.explanation_unit_id and aa.kind<>a.kind order by aa.kind,rr.asset_id limit 2) s),'[]') as siblings,
    (select jsonb_build_object('seriesId',u.series_id,'seriesRevision',u.series_revision,'part',u.part,'total',(select count(*) from content.series_units t where t.series_id=u.series_id and t.series_revision=u.series_revision)) from content.series_units u where u.asset_id=r.asset_id and u.asset_revision=r.revision order by u.series_revision desc,u.series_id limit 1) as series
    from content.assets a join content.asset_revisions r on r.asset_id=a.id join content.discovery_revisions d on d.asset_id=r.asset_id and d.asset_revision=r.revision
    where a.status='admitted' and ${notUnderReview('r.asset_id', 'r.revision')} and ${filter} order by r.asset_id,r.revision limit ${limit}`.execute(
      db,
    );
  return result.rows;
}
/**
 * A Scroll ordered from code (a thread's what-if or perspective) is never a candidate for anyone's
 * Explore: it belongs to the thread it was made for (D-049). Exact reads still find it.
 */
const notOrdered = sql`not exists (select 1 from content.made_to_order_scrolls o where o.asset_id=r.asset_id)`;
/**
 * Where in the random order (`serve_rand`, in [0, 1)) a lane starts: a point derived from the decision seed, so it varies per
 * decision and is the same for the same seed. Without a seed it is the beginning.
 */
export function rotationCursor(rotation: string | undefined): number {
  if (rotation === undefined || rotation === '') return 0;
  return createHash('sha256').update(rotation).digest().readUInt32BE(0) / 4294967296;
}

/**
 * A lane's distance from the cursor, going forward and wrapping round at 1: the sort key (`rot`) that orders a lane. A revision at
 * the cursor is first, the one just before it last.
 */
const distance = (key: ReturnType<typeof sql>, cursor: number) =>
  sql<number>`(case when ${key}>=${cursor}::float8 then ${key}-${cursor}::float8 else ${key}-${cursor}::float8+1 end)`;

/**
 * The rows of one retrieval's lanes. `band` 0 is the person's unseen explanations (only with `unseenFirst`: the rows whose
 * unit is not among the met units) and 1 everything else, so with a list the unseen come first and the rest fill what is left.
 * The met units are one bound array parameter. `<> all` is measured faster than an `unnest` anti-join here: the lane's index
 * scan stops at its limit, so it probes only the rows it reads against the array.
 */
function laneRows(
  q: Parameters<ReadDiscoveryCandidates>[1],
  cursor: number,
  band: 0 | 1,
  metUnitIds: readonly string[] | undefined,
) {
  const topicIds = q.topicIds ?? [];
  const text = (q.text ?? '').trim();
  const current = sql`join content.assets a on a.id=r.asset_id and a.revision=r.revision`;
  const only = metUnitIds === undefined ? sql`` : sql`and r.explanation_unit_id <> all(${metUnitIds}::text[])`;
  const eligible = sql`a.status='admitted' and ${notOrdered} and r.language=any(${q.languages}::text[]) and a.kind=any(${q.formats}::text[]) ${only}`;
  const topicLane = topicIds.length
    ? sql`union all
    (select asset_id,${sql.lit(band)} as band,0 as priority,min(role_rank) as role_rank,min(rot) as rot from (
      select r.asset_id,(t.role='supporting')::int as role_rank,${distance(sql`d.serve_rand`, cursor)} as rot
      from content.encounter_topics t join content.asset_revisions r on r.asset_id=t.asset_id and r.revision=t.asset_revision ${current}
      join content.discovery_revisions d on d.asset_id=r.asset_id and d.asset_revision=r.revision
      where ${eligible} and t.role in ('primary','supporting') and t.topic_id=any(${topicIds}::text[])) in_topics
     group by asset_id order by min(role_rank),min(rot) limit 40)`
    : sql``;
  const textLane = text
    ? sql`union all
    (select r.asset_id,${sql.lit(band)} as band,1 as priority,0 as role_rank,${distance(sql`d.serve_rand`, cursor)} as rot
      from content.discovery_revisions d join content.asset_revisions r on r.asset_id=d.asset_id and r.revision=d.asset_revision ${current}
      where ${eligible} and d.search_text@@plainto_tsquery('simple',${text}) order by rot limit 30)`
    : sql``;
  // Two index range scans, from the cursor to the end and from the start up to the cursor, so the lane stays cheap however
  // large the library is: neither walks more than the lane's share (with a condition, more rows are probed, each by an index).
  const generalLane = sql`
    (select asset_id,${sql.lit(band)} as band,2 as priority,0 as role_rank,rot from (
      (select r.asset_id,${distance(sql`d.serve_rand`, cursor)} as rot
        from content.discovery_revisions d join content.asset_revisions r on r.asset_id=d.asset_id and r.revision=d.asset_revision ${current}
        where d.serve_rand>=${cursor}::float8 and ${eligible} order by d.serve_rand limit 100)
      union all
      (select r.asset_id,${distance(sql`d.serve_rand`, cursor)} as rot
        from content.discovery_revisions d join content.asset_revisions r on r.asset_id=d.asset_id and r.revision=d.asset_revision ${current}
        where d.serve_rand<${cursor}::float8 and ${eligible} order by d.serve_rand limit 100)) wrapped
      order by rot limit 100)`;
  return sql`${generalLane} ${topicLane} ${textLane}`;
}

/**
 * The asset ids of one retrieval, in the order the candidates are read: the source's topics (primary before supporting,
 * never incidental), then text matches when the person typed text, then a rotating sample of the library. Each lane is
 * ordered by the stable random key of its revisions from the cursor, so no lane is the lowest asset ids. With `unseenFirst`
 * every lane is read twice, the unseen first and then without the list, and the unseen of every lane come before any other
 * explanation; `alwaysUnits` (the source's own unit, so its format twin is found) come before all of them.
 */
async function laneAssetIds(
  db: Kysely<Database>,
  q: Parameters<ReadDiscoveryCandidates>[1],
  metUnitIds: readonly string[] | undefined,
): Promise<string[]> {
  const cursor = rotationCursor(q.rotation);
  const always = q.alwaysUnits ?? [];
  const alwaysLane = always.length
    ? sql`union all
    (select r.asset_id,-1 as band,0 as priority,0 as role_rank,0::float8 as rot
      from content.asset_revisions r join content.assets a on a.id=r.asset_id and a.revision=r.revision
      where a.status='admitted' and ${notOrdered} and r.language=any(${q.languages}::text[]) and a.kind=any(${q.formats}::text[])
        and r.explanation_unit_id=any(${always}::text[]) limit 4)`
    : sql``;
  const unseenBand = metUnitIds === undefined ? sql`` : sql`union all ${laneRows(q, cursor, 0, metUnitIds)}`;
  const ids = await sql<{ asset_id: string }>`select asset_id from (
    ${laneRows(q, cursor, 1, undefined)}
    ${unseenBand}
    ${alwaysLane}
  ) lanes group by asset_id order by min(band*100+priority*2+role_rank),min(rot),asset_id limit 100`.execute(db);
  return ids.rows.map((row) => row.asset_id);
}

export const readDiscoveryCandidates: ReadDiscoveryCandidates = async (scope, q) => {
  if (
    q.languages.length < 1 ||
    q.languages.length > 8 ||
    q.formats.length < 1 ||
    q.formats.length > 2 ||
    (q.topicIds?.length ?? 0) > DISCOVERY_MAX_TOPICS ||
    (q.text?.length ?? 0) > 2000 ||
    (q.rotation?.length ?? 0) > 160 ||
    (q.alwaysUnits?.length ?? 0) > 4 ||
    !Number.isSafeInteger(q.limit ?? 100) ||
    (q.limit ?? 100) < 1 ||
    (q.limit ?? 100) > 100
  )
    throw new Error('DISCOVERY_QUERY_INVALID');
  const metUnitIds = q.unseenFirst === undefined ? undefined : validateUnseenFirst(q.unseenFirst);
  const db = transactionOf(scope);
  const assetIds = await laneAssetIds(db, q, metUnitIds);
  if (!assetIds.length) return [];
  const candidates = await rows(db, sql`r.revision=a.revision and r.asset_id=any(${assetIds}::uuid[])`, 100);
  const unsupportedV2 = candidates
    .filter((row) => row.kind === 'scroll' && isScrollDocumentV2(row.document) && !canRender(row, q.capabilities))
    .map((row) => row.asset_id);
  const fallbacks = await olderV1Rows(db, unsupportedV2);
  const byAsset = new Map(candidates.map((row) => [row.asset_id, row]));
  return assetIds
    .flatMap((asset_id) => {
      const row = byAsset.get(asset_id);
      if (row === undefined) return [];
      if (canRender(row, q.capabilities)) return [row];
      const older = fallbacks.get(asset_id);
      return older !== undefined && canRender(older, q.capabilities) ? [older] : [];
    })
    .slice(0, q.limit ?? 100)
    .map(snapshot);
};
export const readExactEncounter: ReadExactEncounter = async (scope, q) => {
  const row = (
    await rows(transactionOf(scope), sql`r.asset_id=${q.assetId}::uuid and r.revision=${q.assetRevision}`, 1)
  )[0];
  return row && canRender(row, q.capabilities) ? snapshot(row) : undefined;
};
export const readEncounterTopics: ReadEncounterTopics = async (scope, ref) => {
  const result = await sql<{
    topicId: string;
    role: 'primary' | 'supporting' | 'incidental';
    weight: number;
  }>`select t.topic_id as "topicId",t.role,t.weight from content.encounter_topics t join content.assets a on a.id=t.asset_id and a.status='admitted' where t.asset_id=${ref.assetId}::uuid and t.asset_revision=${ref.assetRevision} and ${notUnderReview('t.asset_id', 't.asset_revision')} order by t.topic_id limit 17`.execute(
    transactionOf(scope),
  );
  validateTopics(result.rows);
  return result.rows;
};
type LinkRow = {
  id: string;
  revision: number;
  source_asset_id: string;
  source_asset_revision: number;
  target_asset_id: string;
  target_asset_revision: number;
  direction: ContinuityLink['direction'];
  relation: ContinuityLink['relation'];
  strength: number;
  authority_reference: string;
};
export const readContinuations: ReadContinuations = async (scope, source) => {
  const result =
    await sql<LinkRow>`select l.* from content.continuity_links l join content.assets a on a.id=l.source_asset_id and a.status='admitted' join content.assets b on b.id=l.target_asset_id and b.status='admitted' where l.source_asset_id=${source.assetId}::uuid and l.source_asset_revision=${source.assetRevision} and l.active order by l.direction,l.id limit 3`.execute(
      transactionOf(scope),
    );
  return result.rows.map((r) => ({
    linkId: r.id,
    revision: r.revision,
    source: { assetId: r.source_asset_id, assetRevision: r.source_asset_revision },
    target: { assetId: r.target_asset_id, assetRevision: r.target_asset_revision },
    direction: r.direction,
    relation: r.relation,
    strength: r.strength,
    authorityReference: r.authority_reference,
  }));
};
export const resolveContinuityLink: ResolveContinuityLink = async (scope, expected) =>
  (await readContinuations(scope, expected.source)).find(
    (l) =>
      l.linkId === expected.linkId &&
      l.target.assetId === expected.target.assetId &&
      l.target.assetRevision === expected.target.assetRevision &&
      (expected.revision === undefined || l.revision === expected.revision),
  );
async function savedMetadata(scope: Parameters<ReadSavedMetadata>[0], refs: Parameters<ReadSavedMetadata>[1]) {
  if (refs.length > 100) throw new Error('SAVED_METADATA_LIMIT');
  if (!refs.length) return [];
  const result = await sql<{
    assetId: string;
    assetRevision: number;
    status: string | null;
    current: number | null;
    kind: 'reel' | 'scroll' | null;
    title: string | null;
    summary: string | null;
    language: string | null;
  }>`
    select x."assetId",x."assetRevision",a.status,a.revision as current,a.kind,r.title,d.summary,r.language
    from jsonb_to_recordset(${JSON.stringify(refs)}::jsonb) as x("assetId" uuid,"assetRevision" integer)
    left join content.assets a on a.id=x."assetId" left join content.asset_revisions r on r.asset_id=x."assetId" and r.revision=x."assetRevision" and ${notUnderReview('r.asset_id', 'r.revision')}
    left join content.discovery_revisions d on d.asset_id=r.asset_id and d.asset_revision=r.revision`.execute(
    transactionOf(scope),
  );
  return refs.map((ref) => {
    const row = result.rows.find((r) => r.assetId === ref.assetId && r.assetRevision === ref.assetRevision);
    const available =
      row?.status === 'admitted' &&
      row.title !== null &&
      row.language !== null &&
      row.summary !== null &&
      row.kind !== null;
    return {
      ref,
      kind: row?.kind ?? null,
      availability: !available
        ? ('withdrawn' as const)
        : row.current !== ref.assetRevision
          ? ('corrected' as const)
          : ('available' as const),
      ...(available
        ? { metadata: { kind: row.kind!, title: row.title!, summary: row.summary!, language: row.language! } }
        : {}),
      ...(available && row.current !== null && row.current !== ref.assetRevision
        ? { currentAssetRevision: row.current }
        : {}),
    };
  });
}

/** Legacy hydration retains its original wire-independent shape. */
export const readSavedMetadata: ReadSavedMetadata = async (scope, refs) =>
  (await savedMetadata(scope, refs)).map((row) => ({
    ref: row.ref,
    availability: row.availability,
    ...(row.metadata ? { metadata: row.metadata } : {}),
    ...(row.currentAssetRevision !== undefined ? { currentAssetRevision: row.currentAssetRevision } : {}),
  }));
export const readSavedPageMetadata: ReadSavedPageMetadata = async (scope, refs) =>
  (await savedMetadata(scope, refs)).map((row) => {
    if (row.kind !== 'reel' && row.kind !== 'scroll') throw new Error('SAVED_PAGE_KIND_UNAVAILABLE');
    return { ...row, kind: row.kind };
  });

/** Backend attribution read after owned encounter lineage is validated; admission is checked separately for opening. */
export const readEncounterAttribution: ReadEncounterAttribution = async (scope, ref) => {
  const result = await sql<{
    explanation_unit_id: string;
    document_sha256: string;
    facets: string[];
    attribution_version: string;
    topics: EncounterSnapshot['topics'];
  }>`select r.explanation_unit_id,r.document_sha256,d.facets,d.attribution_version,
    coalesce((select jsonb_agg(jsonb_build_object('topicId',t.topic_id,'role',t.role,'weight',t.weight) order by t.topic_id) from content.encounter_topics t where t.asset_id=r.asset_id and t.asset_revision=r.revision),'[]') as topics
    from content.asset_revisions r join content.discovery_revisions d on d.asset_id=r.asset_id and d.asset_revision=r.revision where r.asset_id=${ref.assetId}::uuid and r.revision=${ref.assetRevision} and ${notUnderReview('r.asset_id', 'r.revision')}`.execute(
    transactionOf(scope),
  );
  const r = result.rows[0];
  if (!r) return undefined;
  validateTopics(r.topics);
  return {
    explanationUnitId: r.explanation_unit_id,
    facets: r.facets,
    topics: r.topics,
    attributionVersion: r.attribution_version,
    catalogWatermark: createHash('sha256')
      .update(
        JSON.stringify([
          r.document_sha256,
          r.attribution_version,
          r.facets,
          r.topics.map((t) => [t.topicId, t.role, t.weight]),
        ]),
      )
      .digest('hex'),
  };
};

/** See `ReadPlayLevel`. One row by its key; the review gate hides what it holds, like every exact read. */
export const readPlayLevel: ReadPlayLevel = async (scope, ref) => {
  const row = (
    await sql<{
      document: unknown;
    }>`select r.document from content.asset_revisions r join content.assets a on a.id=r.asset_id
    where r.asset_id=${ref.assetId}::uuid and r.revision=${ref.assetRevision} and a.kind='scroll' and ${notUnderReview('r.asset_id', 'r.revision')}`.execute(
      transactionOf(scope),
    )
  ).rows[0];
  return row === undefined ? 'plain' : traitsOfDocument(row.document).playLevel;
};
