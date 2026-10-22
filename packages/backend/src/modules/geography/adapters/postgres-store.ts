import { sql } from 'kysely';
import { UniverseDeltaSchema, GeographyAliasSchema } from '@knowscroll/contracts';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type {
  GeographyStore,
  GeographyRun,
  GeographyRunHeader,
  GeographySource,
  GeographyContext,
  RegionConstraintPorts,
} from '../application/ports.js';
import { type Place, type Route } from '../domain/policy.js';
const owner = (s: Parameters<GeographyStore['state']>[0]) => ({
  tx: transactionOf(s),
  u: s.authority.universeId,
  e: s.authority.privacyEpoch,
});
type OriginRow = {
  recording_account_id: string | null;
  recording_generation: number | null;
  recording_origin_kind: string | null;
  recording_origin_command_id: string | null;
  recording_origin_source_revision: number | null;
};
function source(g: number | null, k: string | null, c: string | null, r: number | null): GeographySource | undefined {
  if (g === null) {
    if (k !== null || c !== null || r !== null) throw new Error('GEOGRAPHY_STORED_ORIGIN');
    return undefined;
  }
  if (k === 'command' && c !== null && r === null) return { generation: g, kind: k, commandId: c };
  if (k === 'material' && r !== null && r > 0 && c === null) return { generation: g, kind: k, sourceRevision: r };
  if (k === 'legacy1' && g === 1 && r === null && c === null) return { generation: 1, kind: k };
  throw new Error('GEOGRAPHY_STORED_ORIGIN');
}
type HeaderRow = OriginRow & {
  id: string;
  desired_revision: number;
  status: GeographyRun['status'];
  claim_id: string | null;
  claim_until: Date | null;
  normal_wake_id: string | null;
  claim_wake_claim_id: string | null;
  recording_context_sha256: string | null;
  recording_model_context_sha256: string | null;
  has_context: boolean;
  outcome: string | null;
};
function header(r: HeaderRow): GeographyRunHeader {
  const origin = source(
    r.recording_generation,
    r.recording_origin_kind,
    r.recording_origin_command_id,
    r.recording_origin_source_revision,
  );
  if (origin ? !r.recording_account_id : r.recording_account_id !== null) throw new Error('GEOGRAPHY_STORED_ACCOUNT');
  return {
    id: r.id,
    desiredRevision: r.desired_revision,
    status: r.status,
    hasContext: r.has_context,
    ...(origin ? { recording: { accountId: r.recording_account_id!, source: origin } } : {}),
    ...(r.claim_id ? { claimId: r.claim_id } : {}),
    ...(r.claim_until ? { claimUntil: r.claim_until.toISOString() } : {}),
    ...(r.normal_wake_id ? { normalWakeId: r.normal_wake_id } : {}),
    ...(r.claim_wake_claim_id ? { claimWakeClaimId: r.claim_wake_claim_id } : {}),
    ...(r.recording_context_sha256 ? { contextSha256: r.recording_context_sha256 } : {}),
    ...(r.recording_model_context_sha256 ? { modelContextSha256: r.recording_model_context_sha256 } : {}),
    ...(r.outcome ? { outcome: r.outcome } : {}),
  };
}
/** Exact indexed selectors under the existing live personal scope; no private support refs. */
export const readRegionPlace: RegionConstraintPorts['object'] = async (scope, selector) => {
  const { tx, u, e } = owner(scope);
  const predicate = 'id' in selector ? sql`id=${selector.id}::uuid` : sql`semantic_key=${selector.key}`;
  const row = (
    await sql<{ id: string; semantic_key: string; payload: unknown }>`
    select id,semantic_key,payload from geography.objects
    where universe_id=${u}::uuid and privacy_epoch=${e} and ${predicate} limit 1`.execute(tx)
  ).rows[0];
  if (!row) return undefined;
  if (
    !row.payload ||
    typeof row.payload !== 'object' ||
    !('id' in row.payload) ||
    !('key' in row.payload) ||
    row.payload.id !== row.id ||
    row.payload.key !== row.semantic_key
  )
    throw new Error('GEOGRAPHY_STORED_IDENTITY');
  return row.payload;
};
/** Every private lookup retains universe and epoch predicates; IDs grant no access. */
export const geographyStore: GeographyStore = {
  async root(cap) {
    const r = await recordingTransactionOf(cap)
      .selectFrom('identity.universes')
      .select(['account_id', 'revision'])
      .where('id', '=', cap.personal.authority.universeId)
      .executeTakeFirstOrThrow();
    return { accountId: r.account_id, revision: r.revision };
  },
  async header(scope, id) {
    const { tx, u, e } = owner(scope);
    const r = (
      await sql<HeaderRow>`select id,desired_revision,status,claim_id,claim_until,normal_wake_id,claim_wake_claim_id,recording_account_id,recording_generation,recording_origin_kind,recording_origin_command_id,recording_origin_source_revision,recording_context_sha256,recording_model_context_sha256,(context is not null) as has_context,outcome from geography.runs where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid`.execute(
        tx,
      )
    ).rows[0];
    return r ? header(r) : undefined;
  },
  async accountingHeader(scope, id) {
    const { tx, u, e } = owner(scope);
    const r = (
      await sql<{
        id: string;
        status: GeographyRun['status'];
        recording_account_id: string | null;
        recording_generation: number | null;
        normal_wake_id: string | null;
        legacy_origin: boolean;
      }>`select id,status,recording_account_id,recording_generation,normal_wake_id,(recording_account_id is null and recording_generation is null and recording_origin_kind is null and recording_origin_command_id is null and recording_origin_source_revision is null and recording_context_sha256 is null and recording_model_context_sha256 is null) as legacy_origin from geography.runs where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid`.execute(
        tx,
      )
    ).rows[0];
    return r
      ? {
          id: r.id,
          status: r.status,
          legacyOrigin: r.legacy_origin,
          ...(r.normal_wake_id ? { normalWakeId: r.normal_wake_id } : {}),
          ...(r.recording_account_id ? { accountId: r.recording_account_id } : {}),
          ...(r.recording_generation === null ? {} : { generation: r.recording_generation }),
        }
      : undefined;
  },
  async context(cap, id) {
    const r = await recordingTransactionOf(cap)
      .selectFrom('geography.runs')
      .select('context')
      .where('universe_id', '=', cap.personal.authority.universeId)
      .where('privacy_epoch', '=', cap.personal.authority.privacyEpoch)
      .where('id', '=', id)
      .executeTakeFirst();
    return r?.context as unknown as GeographyContext | undefined;
  },
  async consumeNormalWake(scope, id, wakeId) {
    const { tx, u, e } = owner(scope);
    await sql`update geography.runs set normal_wake_id=null,updated_at=now() where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid and normal_wake_id=${wakeId}::uuid`.execute(
      tx,
    );
  },
  async retire(scope, id) {
    const { tx, u, e } = owner(scope);
    await sql`update geography.runs set status='stale',outcome='recording_revoked',claim_id=null,claim_until=null,normal_wake_id=null,claim_wake_claim_id=null,updated_at=now() where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid and status in('queued','prepared','blocked','unknown')`.execute(
      tx,
    );
  },
  async state(scope) {
    const { tx, u, e } = owner(scope);
    const row = (
      await sql<{
        revision: number;
        structure_revision: number;
        activity_revision: number;
        desired_revision: number;
        material_revision: number;
        published_revision: number;
        active_run_id: string | null;
        desired_recording_generation: number | null;
        desired_origin_kind: string | null;
        desired_origin_command_id: string | null;
        desired_origin_source_revision: number | null;
      }>`select * from geography.state where universe_id=${u}::uuid and privacy_epoch=${e}`.execute(tx)
    ).rows[0];
    return row
      ? {
          revision: row.revision,
          structureRevision: row.structure_revision,
          activityRevision: row.activity_revision,
          desiredRevision: row.desired_revision,
          materialRevision: row.material_revision,
          publishedRevision: row.published_revision,
          ...(source(
            row.desired_recording_generation,
            row.desired_origin_kind,
            row.desired_origin_command_id,
            row.desired_origin_source_revision,
          )
            ? {
                desiredSource: source(
                  row.desired_recording_generation,
                  row.desired_origin_kind,
                  row.desired_origin_command_id,
                  row.desired_origin_source_revision,
                ),
              }
            : {}),
          ...(row.active_run_id ? { activeRunId: row.active_run_id } : {}),
        }
      : {
          revision: 0,
          structureRevision: 0,
          activityRevision: 0,
          desiredRevision: 0,
          materialRevision: 0,
          publishedRevision: 0,
        };
  },
  async writeState(scope, s) {
    const { tx, u, e } = owner(scope);
    await sql`insert into geography.state(universe_id,privacy_epoch,revision,structure_revision,activity_revision,desired_revision,material_revision,published_revision,active_run_id,desired_recording_generation,desired_origin_kind,desired_origin_command_id,desired_origin_source_revision)
 values(${u}::uuid,${e},${s.revision},${s.structureRevision},${s.activityRevision},${s.desiredRevision},${s.materialRevision},${s.publishedRevision},${s.activeRunId ?? null}::uuid,${s.desiredSource?.generation ?? null},${s.desiredSource?.kind ?? null},${s.desiredSource?.kind === 'command' ? s.desiredSource.commandId : null}::uuid,${s.desiredSource?.kind === 'material' ? s.desiredSource.sourceRevision : null})
 on conflict(universe_id,privacy_epoch) do update set revision=excluded.revision,structure_revision=excluded.structure_revision,activity_revision=excluded.activity_revision,desired_revision=excluded.desired_revision,material_revision=excluded.material_revision,published_revision=excluded.published_revision,active_run_id=excluded.active_run_id,desired_recording_generation=excluded.desired_recording_generation,desired_origin_kind=excluded.desired_origin_kind,desired_origin_command_id=excluded.desired_origin_command_id,desired_origin_source_revision=excluded.desired_origin_source_revision`.execute(
      tx,
    );
  },
  async view(scope) {
    const { tx, u, e } = owner(scope);
    const objects = (
      await sql<{
        id: string;
        semantic_key: string;
        payload: Place;
      }>`select id,semantic_key,payload from geography.objects where universe_id=${u}::uuid and privacy_epoch=${e} order by id limit 1001`.execute(
        tx,
      )
    ).rows;
    const relations = (
      await sql<{
        id: string;
        semantic_key: string;
        kind: string;
        payload: unknown;
      }>`select id,semantic_key,kind,payload from geography.relations where universe_id=${u}::uuid and privacy_epoch=${e} order by id limit 1001`.execute(
        tx,
      )
    ).rows;
    if (objects.some((r) => r.id !== r.payload.id || r.semantic_key !== r.payload.key))
      throw new Error('GEOGRAPHY_STORED_IDENTITY');
    return {
      state: await geographyStore.state(scope),
      objects: objects.map((r) => r.payload),
      routes: relations
        .filter((r) => r.kind === 'route')
        .map((r) => {
          const route = r.payload as Route;
          if (route.id !== r.id) throw new Error('GEOGRAPHY_STORED_IDENTITY');
          return route;
        }),
      aliases: relations.filter((r) => r.kind === 'alias').map((r) => GeographyAliasSchema.parse(r.payload)),
    };
  },
  async writeRun(scope, r) {
    const { tx, u, e } = owner(scope);
    await sql`insert into geography.runs(universe_id,privacy_epoch,id,desired_revision,status,claim_id,claim_until,context,proposal,attempt_id,outcome,recording_account_id,recording_generation,recording_origin_kind,recording_origin_command_id,recording_origin_source_revision,recording_context_sha256,recording_model_context_sha256,normal_wake_id,claim_wake_claim_id)
 values(${u}::uuid,${e},${r.id}::uuid,${r.desiredRevision},${r.status},${r.claimId ?? null}::uuid,${r.claimUntil ?? null}::timestamptz,${r.context ? JSON.stringify(r.context) : null}::jsonb,${r.proposal ? JSON.stringify(r.proposal) : null}::jsonb,${r.attemptId ?? null}::uuid,${r.outcome ?? null},${r.recording?.accountId ?? null}::uuid,${r.recording?.source.generation ?? null},${r.recording?.source.kind ?? null},${r.recording?.source.kind === 'command' ? r.recording.source.commandId : null}::uuid,${r.recording?.source.kind === 'material' ? r.recording.source.sourceRevision : null},${r.contextSha256 ?? null},${r.modelContextSha256 ?? null},${r.normalWakeId ?? null}::uuid,${r.claimWakeClaimId ?? null}::uuid)
 on conflict(universe_id,id) do update set desired_revision=excluded.desired_revision,status=excluded.status,claim_id=excluded.claim_id,claim_until=excluded.claim_until,context=coalesce(excluded.context,geography.runs.context),proposal=coalesce(excluded.proposal,geography.runs.proposal),attempt_id=coalesce(excluded.attempt_id,geography.runs.attempt_id),outcome=excluded.outcome,recording_account_id=coalesce(excluded.recording_account_id,geography.runs.recording_account_id),recording_generation=coalesce(excluded.recording_generation,geography.runs.recording_generation),recording_origin_kind=coalesce(excluded.recording_origin_kind,geography.runs.recording_origin_kind),recording_origin_command_id=coalesce(excluded.recording_origin_command_id,geography.runs.recording_origin_command_id),recording_origin_source_revision=coalesce(excluded.recording_origin_source_revision,geography.runs.recording_origin_source_revision),recording_context_sha256=coalesce(excluded.recording_context_sha256,geography.runs.recording_context_sha256),recording_model_context_sha256=coalesce(excluded.recording_model_context_sha256,geography.runs.recording_model_context_sha256),normal_wake_id=excluded.normal_wake_id,claim_wake_claim_id=excluded.claim_wake_claim_id,updated_at=now()`.execute(
      tx,
    );
  },
  async findDelta(scope, id) {
    const { tx, u, e } = owner(scope);
    const r = (
      await sql<{
        input_sha256: string;
        payload: unknown;
      }>`select input_sha256,payload from geography.deltas where universe_id=${u}::uuid and privacy_epoch=${e} and transition_id=${id}::uuid`.execute(
        tx,
      )
    ).rows[0];
    return r ? { hash: r.input_sha256, delta: UniverseDeltaSchema.parse(r.payload) } : undefined;
  },
  async deltas(scope, after, limit) {
    const { tx, u, e } = owner(scope);
    const rows = (
      await sql<{
        payload: unknown;
      }>`select payload from geography.deltas where universe_id=${u}::uuid and privacy_epoch=${e} and revision>${after} order by revision limit ${limit}`.execute(
        tx,
      )
    ).rows;
    return rows.map((r) => UniverseDeltaSchema.parse(r.payload));
  },
  async saveObject(scope, o, refs) {
    const { tx, u, e } = owner(scope);
    await sql`insert into geography.objects(universe_id,privacy_epoch,id,semantic_key,payload,support_refs) values(${u}::uuid,${e},${o.id}::uuid,${o.key},${JSON.stringify(o)}::jsonb,${JSON.stringify(refs)}::jsonb)
 on conflict(universe_id,id) do update set payload=excluded.payload,support_refs=excluded.support_refs`.execute(tx);
  },
  async saveRoute(scope, r, refs) {
    const { tx, u, e } = owner(scope);
    const key = [r.fromKey, r.toKey].sort().join('|');
    await sql`insert into geography.relations(universe_id,privacy_epoch,id,semantic_key,kind,payload,support_refs) values(${u}::uuid,${e},${r.id}::uuid,${key},'route',${JSON.stringify(r)}::jsonb,${JSON.stringify(refs)}::jsonb)
 on conflict(universe_id,id) do update set payload=excluded.payload,support_refs=excluded.support_refs`.execute(tx);
  },
  async writeDelta(scope, runId, hash, d) {
    const { tx, u, e } = owner(scope);
    await sql`insert into geography.deltas(universe_id,privacy_epoch,revision,transition_id,run_id,policy_version,input_sha256,payload) values(${u}::uuid,${e},${d.geography.revision},${d.transitionId}::uuid,${runId}::uuid,'geography-passive.v1',${hash},${JSON.stringify(d)}::jsonb)`.execute(
      tx,
    );
  },
};
