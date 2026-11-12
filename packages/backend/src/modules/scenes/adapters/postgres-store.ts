import { sql } from 'kysely';
import { z } from 'zod';
import {
  SceneChunkSchema,
  SceneDescriptorSchema,
  SceneLookSchema,
  PLANET_TYPES,
  type PlanetType,
  type SceneDescriptor,
} from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { LAYOUT_V1, LAYOUT_V2, type SceneLayout } from '../domain/layout.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { SceneStore, SceneState, SkyRow, StoredObject, SystemRow } from '../application/ports.js';
import { projectSceneQueue, ProjectSceneJobSchema } from '../events.js';

const Stamp = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** What `scenes.state.payload` holds: no manifest and no route membership (D-417). An older projector's payload also did. */
const StatePayload = z.looseObject({
  projected: z
    .strictObject({
      geographyRevision: Stamp,
      structureRevision: Stamp,
      activityRevision: Stamp,
      sceneRevision: Stamp,
      personalRevision: Stamp,
    })
    .optional(),
  layout: z.strictObject({ legacyReach: z.number().min(0), nextCell: Stamp }).optional(),
  failure: z
    .strictObject({ geographyRevision: Stamp, reason: z.enum(['limit', 'temporarily_unavailable']) })
    .optional(),
  manifest: z.looseObject({ revisions: z.unknown() }).optional(),
  routeChunks: z.unknown().optional(),
});
const universe = (scope: PersonalScopeTx) => ({
  u: scope.authority.universeId,
  e: scope.authority.privacyEpoch,
  tx: transactionOf(scope),
});
/** `= any($1::uuid[])` over a JavaScript array. */
const ids = (values: readonly string[]) => sql`${sql.join(values.map((v) => sql`${v}::uuid`))}`;

interface ObjectRow {
  system_id: string;
  chunk_id: string;
  slot: number | null;
  layout: SceneLayout;
  payload: { descriptor: unknown };
}
const toObject = (r: ObjectRow): StoredObject => ({
  descriptor: SceneDescriptorSchema.parse(r.payload.descriptor),
  systemId: r.system_id,
  chunkId: r.chunk_id,
  slot: r.slot,
  layout: r.layout === LAYOUT_V2 ? LAYOUT_V2 : LAYOUT_V1,
});

export const sceneStore: SceneStore = {
  async state(scope) {
    const { u, e, tx } = universe(scope);
    const r = await sql<{
      world_seed: string;
      policy_version: SceneState['policyVersion'];
      payload: unknown;
    }>`select world_seed,policy_version,payload from scenes.state where universe_id=${u}::uuid and privacy_epoch=${e}`.execute(
      tx,
    );
    const row = r.rows[0];
    if (!row) return undefined;
    const payload = StatePayload.parse(row.payload);
    const legacy = payload.manifest !== undefined || payload.routeChunks !== undefined;
    return {
      policyVersion: row.policy_version,
      worldSeed: row.world_seed,
      layout: payload.layout ?? { legacyReach: 0, nextCell: 0 },
      ...(payload.projected ? { projected: payload.projected } : {}),
      ...(payload.failure ? { failure: payload.failure } : {}),
      ...(legacy ? { legacy: true as const } : {}),
    };
  },
  async adopt(scope) {
    const { u, e, tx } = universe(scope);
    await sql`select scenes.adopt_legacy_layout(${u}::uuid,${e})`.execute(tx);
  },
  async systems(scope, systemIds) {
    if (!systemIds.length) return [];
    const { u, e, tx } = universe(scope);
    const r = await sql<{
      system_id: string;
      cell: number | null;
      planet_count: number;
      object_count: number;
      scene_revision: number;
    }>`select system_id,cell,planet_count,object_count,scene_revision from scenes.systems
      where universe_id=${u}::uuid and privacy_epoch=${e} and system_id in (${ids(systemIds)}) order by system_id`.execute(
      tx,
    );
    return r.rows.map((row): SystemRow => ({
      systemId: row.system_id,
      cell: row.cell,
      planetCount: row.planet_count,
      objectCount: row.object_count,
      sceneRevision: row.scene_revision,
    }));
  },
  async objectsOfSystems(scope, systemIds) {
    if (!systemIds.length) return [];
    const { u, e, tx } = universe(scope);
    const r = await sql<ObjectRow>`select system_id,chunk_id,slot,layout,payload from scenes.objects
      where universe_id=${u}::uuid and privacy_epoch=${e} and system_id in (${ids(systemIds)}) order by object_id`.execute(
      tx,
    );
    return r.rows.map(toObject);
  },
  async objectsById(scope, objectIds) {
    if (!objectIds.length) return [];
    const { u, e, tx } = universe(scope);
    const r = await sql<ObjectRow>`select system_id,chunk_id,slot,layout,payload from scenes.objects
      where universe_id=${u}::uuid and privacy_epoch=${e} and object_id in (${ids(objectIds)}) order by object_id`.execute(
      tx,
    );
    return r.rows.map(toObject);
  },
  async currentChunks(scope, systemIds) {
    if (!systemIds.length) return [];
    const { u, e, tx } = universe(scope);
    const r = await sql<{
      system_id: string;
      payload: unknown;
    }>`select distinct on (chunk_id) system_id,payload from scenes.chunks
      where universe_id=${u}::uuid and privacy_epoch=${e} and system_id in (${ids(systemIds)})
      order by chunk_id,scene_revision desc`.execute(tx);
    return r.rows.map((row) => ({ systemId: row.system_id, chunk: SceneChunkSchema.parse(row.payload) }));
  },
  async chunkHeads(scope, systemId) {
    const { u, e, tx } = universe(scope);
    const r = await sql<{
      chunk_id: string;
      scene_revision: number;
      system_id: string;
      object_ids: string[];
      routes: number;
    }>`select * from (select distinct on (chunk_id) chunk_id,scene_revision,system_id,
        jsonb_path_query_array(payload,'$.objects[*].objectId') as object_ids,
        jsonb_array_length(payload->'routes') as routes
      from scenes.chunks where universe_id=${u}::uuid and privacy_epoch=${e}
      ${systemId === undefined ? sql`` : sql`and system_id=${systemId}::uuid`}
      order by chunk_id,scene_revision desc) heads
      where jsonb_array_length(object_ids)+routes>0 order by chunk_id`.execute(tx);
    return r.rows.map((row) => ({
      systemId: row.system_id,
      chunkId: row.chunk_id,
      sceneRevision: row.scene_revision,
      objectIds: row.object_ids,
    }));
  },
  async currentChunk(scope, chunkId) {
    const { u, e, tx } = universe(scope);
    const r = await sql<{
      system_id: string;
      payload: unknown;
    }>`select system_id,payload from scenes.chunks where universe_id=${u}::uuid and privacy_epoch=${e} and chunk_id=${chunkId}::uuid
      order by scene_revision desc limit 1`.execute(tx);
    const row = r.rows[0];
    return row ? { systemId: row.system_id, chunk: SceneChunkSchema.parse(row.payload) } : undefined;
  },
  async chunk(scope, id, revision) {
    const { u, e, tx } = universe(scope);
    const r = await sql<{
      system_id: string;
      payload: unknown;
      current: boolean;
    }>`select system_id,payload,not exists(select 1 from scenes.chunks newer where newer.universe_id=c.universe_id and newer.privacy_epoch=c.privacy_epoch
        and newer.chunk_id=c.chunk_id and newer.scene_revision>c.scene_revision) as current
      from scenes.chunks c where universe_id=${u}::uuid and privacy_epoch=${e} and chunk_id=${id}::uuid and scene_revision=${revision}`.execute(
      tx,
    );
    const row = r.rows[0];
    return row
      ? { systemId: row.system_id, chunk: SceneChunkSchema.parse(row.payload), current: row.current }
      : undefined;
  },
  async looksOf(scope, objectIds) {
    if (!objectIds.length) return [];
    const { u, e, tx } = universe(scope);
    const r = await sql<{ payload: unknown }>`select payload from scenes.looks
      where universe_id=${u}::uuid and privacy_epoch=${e} and object_id in (${ids(objectIds)}) order by object_id`.execute(
      tx,
    );
    return r.rows.map((row) => SceneLookSchema.parse(row.payload));
  },
  async planetTypeCounts(scope) {
    const { u, e, tx } = universe(scope);
    const r = await sql<{
      type: string;
      n: string;
    }>`select payload->>'type' as type,count(*)::text as n from scenes.looks
      where universe_id=${u}::uuid and privacy_epoch=${e} and kind='planet' group by 1`.execute(tx);
    return new Map<PlanetType, number>(
      r.rows
        .filter((row): row is { type: PlanetType; n: string } => (PLANET_TYPES as readonly string[]).includes(row.type))
        .map((row) => [row.type, Number(row.n)]),
    );
  },
  async saveLooks(scope, looks) {
    const { u, e, tx } = universe(scope);
    for (const look of looks)
      await sql`insert into scenes.looks(universe_id,privacy_epoch,object_id,kind,payload) values(${u}::uuid,${e},${look.objectId}::uuid,${look.kind},${JSON.stringify(look)}::jsonb) on conflict(universe_id,privacy_epoch,object_id) do nothing`.execute(
        tx,
      );
  },
  async saveObjects(scope, objects) {
    const { u, e, tx } = universe(scope);
    for (const o of objects)
      await sql`insert into scenes.objects(universe_id,privacy_epoch,object_id,system_id,chunk_id,slot,layout,payload) values(${u}::uuid,${e},${o.descriptor.objectId}::uuid,${o.systemId}::uuid,${o.chunkId}::uuid,${o.slot},${o.layout},${JSON.stringify({ descriptor: o.descriptor, systemId: o.systemId, chunkId: o.chunkId, slot: o.slot })}::jsonb)
        on conflict(universe_id,privacy_epoch,object_id) do update set payload=excluded.payload`.execute(tx);
  },
  async saveChunks(scope, chunks) {
    const { u, e, tx } = universe(scope);
    for (const c of chunks)
      await sql`insert into scenes.chunks(universe_id,privacy_epoch,chunk_id,scene_revision,system_id,payload) values(${u}::uuid,${e},${c.chunk.chunkId}::uuid,${c.chunk.revisions.sceneRevision},${c.systemId}::uuid,${JSON.stringify(c.chunk)}::jsonb)`.execute(
        tx,
      );
  },
  async saveSystems(scope, rows) {
    const { u, e, tx } = universe(scope);
    for (const r of rows)
      await sql`insert into scenes.systems(universe_id,privacy_epoch,system_id,cell,planet_count,object_count,scene_revision) values(${u}::uuid,${e},${r.systemId}::uuid,${r.cell},${r.planetCount},${r.objectCount},${r.sceneRevision})
        on conflict(universe_id,privacy_epoch,system_id) do update set planet_count=excluded.planet_count,object_count=excluded.object_count,scene_revision=excluded.scene_revision`.execute(
        tx,
      );
  },
  async saveState(scope, state) {
    const { u, e, tx } = universe(scope);
    const { worldSeed, policyVersion, ...rest } = state;
    const payload = {
      ...(rest.projected ? { projected: rest.projected } : {}),
      layout: rest.layout,
      ...(rest.failure ? { failure: rest.failure } : {}),
    };
    await sql`insert into scenes.state(universe_id,privacy_epoch,policy_version,world_seed,scene_revision,payload) values(${u}::uuid,${e},${policyVersion},${worldSeed},${state.projected?.sceneRevision ?? 0},${JSON.stringify(payload)}::jsonb) on conflict(universe_id,privacy_epoch) do update set scene_revision=excluded.scene_revision,payload=excluded.payload`.execute(
      tx,
    );
  },
  async mark(scope) {
    await sql`savepoint scene_projection`.execute(transactionOf(scope));
  },
  async rollback(scope) {
    await sql`rollback to savepoint scene_projection`.execute(transactionOf(scope));
  },
  async sky(scope, query) {
    const { u, e, tx } = universe(scope);
    const floor = query.after ?? '00000000-0000-0000-0000-000000000000';
    const r = await sql<{
      descriptor: unknown;
      planet_count: number;
      scene_revision: number;
      haze: string | null;
    }>`select o.payload->'descriptor' as descriptor,s.planet_count,s.scene_revision,l.payload->>'haze' as haze
      from scenes.systems s
      join scenes.objects o on o.universe_id=s.universe_id and o.privacy_epoch=s.privacy_epoch and o.object_id=s.system_id
      left join scenes.looks l on l.universe_id=s.universe_id and l.privacy_epoch=s.privacy_epoch and l.object_id=s.system_id
      where s.universe_id=${u}::uuid and s.privacy_epoch=${e} and s.system_id>${floor}::uuid
      ${query.since === undefined ? sql`` : sql`and s.scene_revision>${query.since}`}
      order by s.system_id limit ${query.limit}`.execute(tx);
    // The descriptor was parsed by the canonical parser when it was stored, and the sky read parses the whole reply
    // again at its boundary: not a third time per entry, which is most of what a page of 200 costs.
    return r.rows.map((row) => ({
      descriptor: row.descriptor as SceneDescriptor,
      ...(row.haze ? { haze: row.haze as NonNullable<SkyRow['haze']> } : {}),
      planetCount: row.planet_count,
      sceneRevision: row.scene_revision,
    }));
  },
  async systemIds(scope, after, limit) {
    const { u, e, tx } = universe(scope);
    const r = await sql<{ system_id: string }>`select system_id from scenes.systems
      where universe_id=${u}::uuid and privacy_epoch=${e} and system_id>${after ?? '00000000-0000-0000-0000-000000000000'}::uuid
      order by system_id limit ${limit}`.execute(tx);
    return r.rows.map((row) => row.system_id);
  },
  async legacyFit(scope) {
    const { u, e, tx } = universe(scope);
    const count = (
      await sql<{
        n: string;
      }>`select coalesce(sum(object_count),0)::text as n from scenes.systems where universe_id=${u}::uuid and privacy_epoch=${e}`.execute(
        tx,
      )
    ).rows[0]!.n;
    const objects = Number(count);
    // Past the object ceiling nothing else decides it: skip the scans.
    if (objects > 1000) return { objects, anchor: 0, variant: 0 };
    const measured = (
      await sql<{ anchor: string; variant: string }>`select
        coalesce((select max(greatest(abs((payload->'descriptor'->'anchor'->>'x')::numeric),abs((payload->'descriptor'->'anchor'->>'y')::numeric)))
          from scenes.objects where universe_id=${u}::uuid and privacy_epoch=${e}),0)::text as anchor,
        coalesce((select max((payload->>'variant')::integer) from scenes.looks where universe_id=${u}::uuid and privacy_epoch=${e} and kind='planet'),0)::text as variant`.execute(
        tx,
      )
    ).rows[0]!;
    return { objects, anchor: Number(measured.anchor), variant: Number(measured.variant) };
  },
  async pending(scope) {
    const r = await sql<{
      data: unknown;
    }>`select data from pgboss.job where name=${projectSceneQueue.name} and state in('created','retry','active') and data->>'universeId'=${scope.authority.universeId} and data->>'privacyEpoch'=${String(scope.authority.privacyEpoch)} order by (data->'geography'->>'revision')::bigint desc limit 1`.execute(
      transactionOf(scope),
    );
    const parsed = ProjectSceneJobSchema.safeParse(r.rows[0]?.data);
    return parsed.success
      ? { geographyRevision: parsed.data.geography.revision, personalRevision: parsed.data.personalRevision }
      : undefined;
  },
};
