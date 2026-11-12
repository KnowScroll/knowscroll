import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { SYSTEM_SIZE, type LoadSize } from './config.js';

/**
 * Bulk seeding by SQL (`insert … select … from generate_series`), so a hundred thousand assets cost seconds, not hours. Every row
 * here is a labelled load fixture: ids are derived from `md5('l…' || n)`, titles say `Load unit`, nothing is content a person or a
 * model wrote, and nothing is evidence of anyone. The documents are the real compiled starter Scroll (`scroll-document`) and a valid
 * Reel document, so the real retrieval parses and negotiates what it reads.
 */

/** SQL for the id of topic index `expr`, the same string as `topicId(index)` in config.ts. */
const topicSql = (expr: string) =>
  `('load.s' || lpad(((${expr}) / ${String(SYSTEM_SIZE)})::text, 3, '0') || '.t' || lpad((${expr})::text, 5, '0'))`;

export interface StarterRow {
  readonly document: unknown;
  readonly documentVersion: string;
  readonly readingFacts: unknown;
}

/** Template Scroll: the real compiled starter Scroll's stored document and reading facts, read back from the database. */
export async function readStarter(db: Kysely<Database>, assetId: string): Promise<StarterRow> {
  const row = await db
    .selectFrom('content.asset_revisions')
    .select(['document', 'document_version', 'reading_facts'])
    .where('asset_id', '=', assetId)
    .where('revision', '=', 1)
    .executeTakeFirstOrThrow();
  return { document: row.document, documentVersion: row.document_version, readingFacts: row.reading_facts };
}

export interface LibraryCounts {
  readonly scrolls: number;
  readonly reels: number;
  readonly assets: number;
  readonly topics: number;
  readonly encounterTopics: number;
  readonly releasedBindings: number;
}

/**
 * The library: `units` explanation units over `topics` topics. Unit n has a Scroll (`md5('ls'||n)`), and when `n % 10 < 7` a Reel twin
 * (`md5('lr'||n)`) sharing its explanation id `lu-n`. Its primary topic is index `(n-1) % topics`; three units in ten also have a
 * supporting topic. Every Scroll is released through a coverage head (so the gap scan reads it from `region_bindings`).
 */
export async function seedLibrary(
  db: Kysely<Database>,
  size: LoadSize,
  starter: StarterRow,
  log: (line: string) => void,
): Promise<LibraryCounts> {
  const chunk = 10_000;
  const doc = JSON.stringify(starter.document);
  const facts = JSON.stringify(starter.readingFacts);
  const reelFacts = JSON.stringify({
    v: 2,
    measuresVersion: 'reel-duration.v1',
    totalWeight: 0,
    estimatedReadingMs: 30_000,
    blocks: [],
    nested: [],
    reelDurationMs: 30_000,
  });
  const twin = (n: string) => `(${n} % 10) < ${String(Math.round(size.reelTwinShare * 10))}`;
  // Ids derived from a seed, shaped as the contracts require (version 4, variant 8): `md5(...)::uuid` is not a valid UUID to them.
  await sql`create or replace function public.load_uuid(seed text) returns uuid language sql immutable as $$
    select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
    from (select md5(seed) as h) x $$`.execute(db);
  // The weight trigger runs one query per row and the rows are valid by construction (at most two topics, weights summing to 1).
  await sql`alter table content.encounter_topics disable trigger check_topic_weights`.execute(db);
  try {
    for (let from = 1; from <= size.units; from += chunk) {
      const to = Math.min(size.units, from + chunk - 1);
      const range = sql.raw(`generate_series(${String(from)}, ${String(to)}) as g(n)`);
      await sql`insert into content.assets(id, revision, kind, status)
        select load_uuid('ls' || n), 1, 'scroll', 'admitted' from ${range}`.execute(db);
      await sql`insert into content.assets(id, revision, kind, status)
        select load_uuid('lr' || n), 1, 'reel', 'admitted' from ${range} where ${sql.raw(twin('n'))}`.execute(db);
      await sql`insert into content.asset_revisions(asset_id, revision, provenance_kind, document_version, document, document_sha256,
          explanation_unit_id, language, title, reading_facts)
        select load_uuid('ls' || n), 1, 'authored_editorial', ${starter.documentVersion}, ${doc}::jsonb, md5('d' || n) || md5('e' || n),
          'lu-' || n, 'en', 'Load unit ' || n, ${facts}::jsonb from ${range}`.execute(db);
      await sql`insert into content.asset_revisions(asset_id, revision, provenance_kind, document_version, document, document_sha256,
          explanation_unit_id, language, title, reading_facts)
        select load_uuid('lr' || n), 1, 'authored_editorial', 'reel-document.v1',
          jsonb_build_object('schemaVersion', 'reel-document.v1', 'assetId', load_uuid('lr' || n)::text, 'revision', 1,
            'title', 'Load unit ' || n || ' (Reel)', 'summary', 'Load fixture', 'language', 'en', 'truthLabel', 'generated',
            'fixture', true, 'captions', 'burned_in', 'mediaKey', 'sha256/ab/' || md5('r' || n) || md5('s' || n) || '.mp4',
            'durationMs', 30000, 'width', 1080, 'height', 1920),
          md5('r' || n) || md5('s' || n), 'lu-' || n, 'en', 'Load unit ' || n || ' (Reel)', ${reelFacts}::jsonb
        from ${range} where ${sql.raw(twin('n'))}`.execute(db);
      // Topics: primary for every unit, a supporting one for three units in ten (weights 0.7 and 0.3). Both formats of a unit share them.
      const primaryOf = (col: string) => topicSql(`(${col} - 1) % ${String(size.topics)}`);
      // Never the primary topic: offset by 1 + (n * 7919) mod (topics - 1).
      const supportingOf = (col: string) =>
        topicSql(`((${col} - 1) + 1 + (${col} * 7919) % ${String(size.topics - 1)}) % ${String(size.topics)}`);
      const primary = primaryOf('n');
      const formatsOf =
        sql.raw(`(select n, load_uuid('ls' || n) as id from generate_series(${String(from)}, ${String(to)}) n
        union all select n, load_uuid('lr' || n) from generate_series(${String(from)}, ${String(to)}) n where ${twin('n')}) f`);
      await sql`insert into content.encounter_topics(asset_id, asset_revision, topic_id, role, weight)
        select f.id, 1, ${sql.raw(primaryOf('f.n'))}, 'primary', case when f.n % 10 < 3 then 0.7 else 1.0 end from ${formatsOf}`.execute(
        db,
      );
      await sql`insert into content.encounter_topics(asset_id, asset_revision, topic_id, role, weight)
        select f.id, 1, ${sql.raw(supportingOf('f.n'))}, 'supporting', 0.3 from ${formatsOf}
        where f.n % 10 < 3`.execute(db);
      // Release every Scroll through an admitted coverage head: one binding, its primary topic and one of three facets.
      await sql`insert into content.coverage_revisions(asset_id, asset_revision, revision, status, mapping_sha256, command_sha256,
          semantic_review_reference, mapping)
        select load_uuid('ls' || n), 1, 1, 'active', md5('m' || n) || md5('n' || n), md5('c' || n) || md5('k' || n), 'load-fixture-only',
          jsonb_build_object('version', 'scroll-static-coverage.v1', 'catalogueVersion', 'content-concepts.v1', 'framing', 'factual',
            'bindings', jsonb_build_array(jsonb_build_object('topicId', ${sql.raw(primary)}, 'facetId', ${sql.raw(primary)} || '.f' || (n % 3))))
        from ${range}`.execute(db);
      await sql`insert into content.coverage_heads(asset_id, asset_revision, revision)
        select load_uuid('ls' || n), 1, 1 from ${range}`.execute(db);
      log(`library ${String(to)}/${String(size.units)} units`);
    }
  } finally {
    await sql`alter table content.encounter_topics enable trigger check_topic_weights`.execute(db);
  }
  const count = async (table: string, where = sql``) =>
    Number((await sql<{ n: string }>`select count(*) as n from ${sql.table(table)} ${where}`.execute(db)).rows[0]!.n);
  return {
    scrolls: await count('content.assets', sql`where kind = 'scroll'`),
    reels: await count('content.assets', sql`where kind = 'reel'`),
    assets: await count('content.assets'),
    topics: Number(
      (await sql<{ n: string }>`select count(distinct topic_id) as n from content.encounter_topics`.execute(db))
        .rows[0]!.n,
    ),
    encounterTopics: await count('content.encounter_topics'),
    releasedBindings: await count('content.region_bindings'),
  };
}

/**
 * History of readers by SQL: `perReader` met units each (the Scroll of unit `1 + hash(universe, k) % units`, activated `stepMinutes`
 * apart, newest first), with the topic statistics the Composer reads for each topic those units are about. The rows are the ones the
 * Evidence and Experience projections write for a read-and-qualified encounter (an exposure and its lineage; `topic_context`,
 * `topic_format_cells`, Personal Context's `topics`); they are written directly, not by qualifying thousands of encounters.
 */
export async function seedHistory(
  db: Kysely<Database>,
  universeIds: readonly string[],
  size: LoadSize,
  perReader: number,
  options: { readonly sequential: boolean; readonly stepMinutes: number },
): Promise<void> {
  if (universeIds.length === 0) return;
  const unit = options.sequential
    ? sql.raw('s.k')
    : sql.raw(`1 + (abs(hashtext(s.u::text || ':' || s.k::text)) % ${String(size.units)})`);
  const history = sql`(select s0.u, k0.k from unnest(${universeIds}::uuid[]) as s0(u) cross join generate_series(1, ${perReader}::int) as k0(k)) s`;
  await sql`drop table if exists load_history`.execute(db);
  await sql`create unlogged table load_history as
    select s.u as universe_id, s.k, ${unit} as n, now() - s.k * ${options.stepMinutes} * interval '1 minute' as at
    from ${history}`.execute(db);
  await sql`insert into experience.exposures(universe_id, id, asset_id, asset_revision, kind, origin, capabilities, command_id,
      privacy_epoch, opened_at, activated_at)
    select universe_id, load_uuid(universe_id::text || ':x:' || k), load_uuid('ls' || n), 1, 'scroll', 'direct', '{}'::jsonb,
      load_uuid(universe_id::text || ':c:' || k), 1, at - interval '1 minute', at from load_history`.execute(db);
  await sql`insert into experience.encounter_lineage(universe_id, privacy_epoch, exposure_id, asset_id, asset_revision, kind,
      explanation_unit_id, facets, activated_at)
    select universe_id, 1, load_uuid(universe_id::text || ':x:' || k), load_uuid('ls' || n), 1, 'scroll', 'lu-' || n,
      array[${sql.raw(topicSql(`(n - 1) % ${String(size.topics)}`))} || '.f' || (n % 3)], at from load_history`.execute(
    db,
  );
  // One statistics row per reader and topic (the newest encounter of the topic decides its time).
  await sql`create unlogged table load_topics as
    select universe_id, ${sql.raw(topicSql(`(n - 1) % ${String(size.topics)}`))} as topic_id, count(*)::int as met, max(at) as at
    from load_history group by 1, 2`.execute(db);
  await sql`insert into evidence.topic_context(universe_id, privacy_epoch, topic_id, channel_values, activity, evaluated_at,
      reel_measured, reel_qualified, scroll_measured, scroll_qualified)
    select universe_id, 1, topic_id, '{"q":0.6,"L":0,"B":0,"S":0,"H":0,"R":0}'::jsonb, 0.6, at, 0, 0, met, met from load_topics`.execute(
    db,
  );
  await sql`insert into evidence.topic_format_cells(universe_id, privacy_epoch, topic_id, kind, play_level, measured, qualified)
    select universe_id, 1, topic_id, 'scroll', 'plain', met, met from load_topics`.execute(db);
  await sql`insert into personal_context.topics(universe_id, privacy_epoch, topic_id, qualified_units, covered_facets)
    select universe_id, 1, topic_id, met, 1 from load_topics`.execute(db);
  await sql`drop table load_history`.execute(db);
  await sql`drop table load_topics`.execute(db);
}

/** The support index rows the projections keep for the heavy reader's planets, seeded directly (the pattern of incremental-formation.test.ts). */
export interface SupportKey {
  readonly topicId: string;
  readonly facetId: string;
  readonly unit: string;
  readonly ageDays: number;
}

export async function seedSupports(
  db: Kysely<Database>,
  universeId: string,
  keys: readonly SupportKey[],
): Promise<void> {
  const chunk = 5_000;
  for (let start = 0; start < keys.length; start += chunk) {
    const part = keys.slice(start, start + chunk);
    await sql`insert into personal_context.coverage_supports(universe_id, privacy_epoch, topic_id, facet_id, meaning_sha256,
        explanation_unit_id, truth_sha256, reference_count, last_activated_at)
      select ${universeId}::uuid, 1, t, f, repeat('0', 64), u, repeat('0', 64), 1, now() - a * interval '1 day'
      from unnest(${part.map((key) => key.topicId)}::text[], ${part.map((key) => key.facetId)}::text[],
        ${part.map((key) => key.unit)}::text[], ${part.map((key) => key.ageDays)}::int[]) as seed(t, f, u, a)`.execute(
      db,
    );
  }
}

/** Planner-style statistics the planner of Postgres needs on freshly bulk-loaded tables, as autovacuum would have gathered them. */
export async function analyzeAll(db: Kysely<Database>): Promise<void> {
  await sql`analyze`.execute(db);
}

/**
 * Places written by SQL, because the real formation stops at 1,000 stored places per reader (the limit this test records): the missing
 * systems, stars, planets and regions of the synthetic catalogue, cloned from the shapes the real formation stored for this reader (a
 * template of each kind, with a new id, key, concept and parent). They are labelled fixtures, not formation: no run made them and no
 * reading supports them. Returns how many rows it wrote.
 */
export async function inflatePlaces(
  db: Kysely<Database>,
  universeId: string,
  planets: number,
  conceptOf: (index: number) => {
    readonly system: string;
    readonly planet: string;
    readonly facets: readonly string[];
  },
): Promise<number> {
  const existing = await sql<{
    semantic_key: string;
    payload: Record<string, unknown>;
  }>`select semantic_key, payload from geography.objects
    where universe_id = ${universeId}::uuid and privacy_epoch = 1`.execute(db);
  const have = new Set(existing.rows.map((row) => row.semantic_key));
  const template = (kind: string) => existing.rows.find((row) => row.payload['kind'] === kind)?.payload;
  const [system, star, planet, region] = ['system', 'star', 'planet', 'region'].map(template);
  if (!system || !star || !planet || !region) throw new Error('LOAD_INFLATE_NO_TEMPLATE');
  const keyOf = (t: Record<string, unknown>, concept: string) =>
    String(t['key']).replace(String(t['conceptId']), concept);
  const rows: { id: string; key: string; payload: string }[] = [];
  const add = (t: Record<string, unknown>, concept: string, parentKey: string) => {
    const key = keyOf(t, concept);
    if (have.has(key)) return key;
    have.add(key);
    const id = randomUUID();
    rows.push({
      id,
      key,
      payload: JSON.stringify({
        ...t,
        id,
        key,
        conceptId: concept,
        parentKey,
        label: `Load ${concept}`,
        labels: [`Load ${concept}`],
      }),
    });
    return key;
  };
  for (let index = 0; index < planets; index++) {
    const c = conceptOf(index);
    const systemKey = add(system, c.system, 'universe');
    add(star, c.system, systemKey);
    const planetKey = add(planet, c.planet, systemKey);
    for (const facet of c.facets) add(region, facet, planetKey);
  }
  const chunk = 2_000;
  for (let start = 0; start < rows.length; start += chunk) {
    const part = rows.slice(start, start + chunk);
    await sql`insert into geography.objects(universe_id, privacy_epoch, id, semantic_key, payload, support_refs, last_support_at)
      select ${universeId}::uuid, 1, i, k, p::jsonb, '[]'::jsonb, now() - interval '3 days'
      from unnest(${part.map((row) => row.id)}::uuid[], ${part.map((row) => row.key)}::text[], ${part.map((row) => row.payload)}::text[]) as x(i, k, p)`.execute(
      db,
    );
  }
  return rows.length;
}
