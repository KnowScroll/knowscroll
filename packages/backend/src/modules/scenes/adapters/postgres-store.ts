import { sql } from 'kysely';
import { SceneManifestSchema, SceneChunkSchema, SceneDescriptorSchema } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { SceneStore, SceneState, StoredObject } from '../application/ports.js';
import { projectSceneQueue, ProjectSceneJobSchema } from '../events.js';
export const sceneStore: SceneStore = {
  async state(scope) {
    const r = await sql<{
      world_seed: string;
      policy_version: SceneState['policyVersion'];
      payload: SceneState;
    }>`select world_seed,policy_version,payload from scenes.state where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch}`.execute(
      transactionOf(scope),
    );
    const row = r.rows[0];
    if (!row) return undefined;
    return {
      ...row.payload,
      worldSeed: row.world_seed,
      policyVersion: row.policy_version,
      ...(row.payload.manifest ? { manifest: SceneManifestSchema.parse(row.payload.manifest) } : {}),
    };
  },
  async objects(scope) {
    const r = await sql<{
      payload: StoredObject;
    }>`select payload from scenes.objects where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} order by object_id limit 1001`.execute(
      transactionOf(scope),
    );
    return r.rows.map((r) => ({ ...r.payload, descriptor: SceneDescriptorSchema.parse(r.payload.descriptor) }));
  },
  async chunk(scope, id, revision) {
    const r = await sql<{
      system_id: string;
      payload: unknown;
    }>`select system_id,payload from scenes.chunks where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and chunk_id=${id}::uuid and scene_revision=${revision}`.execute(
      transactionOf(scope),
    );
    const row = r.rows[0];
    return row ? { systemId: row.system_id, chunk: SceneChunkSchema.parse(row.payload) } : undefined;
  },
  async save(scope, state, objects, changed) {
    const tx = transactionOf(scope),
      u = scope.authority.universeId,
      e = scope.authority.privacyEpoch;
    for (const o of objects)
      await sql`insert into scenes.objects(universe_id,privacy_epoch,object_id,system_id,chunk_id,slot,payload) values(${u}::uuid,${e},${o.descriptor.objectId}::uuid,${o.systemId}::uuid,${o.chunkId}::uuid,${o.slot},${JSON.stringify(o)}::jsonb) on conflict(universe_id,privacy_epoch,object_id) do update set payload=excluded.payload`.execute(
        tx,
      );
    for (const c of changed)
      await sql`insert into scenes.chunks(universe_id,privacy_epoch,chunk_id,scene_revision,system_id,payload) values(${u}::uuid,${e},${c.chunk.chunkId}::uuid,${c.chunk.revisions.sceneRevision},${c.systemId}::uuid,${JSON.stringify(c.chunk)}::jsonb)`.execute(
        tx,
      );
    if (state.manifest && !state.failure)
      await sql`insert into scenes.manifests(universe_id,privacy_epoch,scene_revision,payload) values(${u}::uuid,${e},${state.manifest.revisions.sceneRevision},${JSON.stringify(state.manifest)}::jsonb)`.execute(
        tx,
      );
    const { worldSeed, ...payload } = state;
    await sql`insert into scenes.state(universe_id,privacy_epoch,policy_version,world_seed,scene_revision,payload) values(${u}::uuid,${e},${state.policyVersion},${worldSeed},${state.manifest?.revisions.sceneRevision ?? 0},${JSON.stringify(payload)}::jsonb) on conflict(universe_id,privacy_epoch) do update set scene_revision=excluded.scene_revision,payload=excluded.payload`.execute(
      tx,
    );
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
