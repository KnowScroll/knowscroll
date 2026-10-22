import { sql } from 'kysely';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PlannerStore, PlannerState, PlannerRun, PlannerSource, FrozenContext } from '../application/ports.js';
import { IntentSchema, OpportunitySchema } from '../domain/proposal.js';
const identity = (s: Parameters<PlannerStore['state']>[0]) => ({
  db: transactionOf(s),
  u: s.authority.universeId,
  e: s.authority.privacyEpoch,
});
type SourceRow = {
  generation: number | null;
  origin_kind: string | null;
  origin_command_id: string | null;
  origin_source_revision: number | null;
};
function source(r: SourceRow): PlannerSource | undefined {
  if (r.generation === null) return undefined;
  if (r.origin_kind === 'material' && r.origin_source_revision !== null)
    return { generation: r.generation, kind: 'material', sourceRevision: r.origin_source_revision };
  if (r.origin_kind === 'command' && r.origin_command_id !== null)
    return { generation: r.generation, kind: 'command', commandId: r.origin_command_id };
  if (r.origin_kind === 'legacy1' && r.generation === 1) return { generation: 1, kind: 'legacy1' };
  throw new Error('PLANNER_SOURCE_INVALID');
}
async function state(scope: Parameters<PlannerStore['state']>[0], includeIntent: boolean) {
  const { db, u, e } = identity(scope);
  const row = (
    await sql<
      SourceRow & {
        desired_revision: number;
        material_revision: number;
        accepted_revision: number;
        active_run_id: string | null;
        intent: unknown;
      }
    >`
 select desired_revision,material_revision,accepted_revision,active_run_id,
 desired_recording_generation as generation,desired_origin_kind as origin_kind,desired_origin_command_id as origin_command_id,desired_origin_source_revision as origin_source_revision,
 ${includeIntent ? sql`intent` : sql`null::jsonb`} as intent from planner.state where universe_id=${u}::uuid and privacy_epoch=${e}`.execute(
      db,
    )
  ).rows[0];
  if (!row) return { desiredRevision: 0, materialRevision: 0, acceptedRevision: 0 };
  const desiredSource = source(row);
  return {
    desiredRevision: row.desired_revision,
    materialRevision: row.material_revision,
    acceptedRevision: row.accepted_revision,
    ...(row.active_run_id ? { activeRunId: row.active_run_id } : {}),
    ...(desiredSource ? { desiredSource } : {}),
    ...(row.intent ? { intent: IntentSchema.parse(row.intent) } : {}),
  };
}
export const plannerStore: PlannerStore = {
  async consumeNormalWake(scope, id, wakeId) {
    const { db, u, e } = identity(scope);
    const result = await sql`update planner.runs set normal_wake_id=null,updated_at=now()
      where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid and normal_wake_id=${wakeId}::uuid returning id`.execute(
      db,
    );
    return result.rows.length === 1;
  },
  async accountingHeader(scope, id) {
    const { db, u, e } = identity(scope);
    const row = (
      await sql<{
        id: string;
        status: PlannerRun['status'];
        recording_account_id: string | null;
        recording_generation: number | null;
        normal_wake_id: string | null;
        legacy_unproved: boolean;
      }>`select id,status,recording_account_id,recording_generation,normal_wake_id,(recording_account_id is null and recording_generation is null and recording_origin_kind is null and recording_origin_command_id is null and recording_origin_source_revision is null and recording_context_sha256 is null and recording_model_context_sha256 is null) as legacy_unproved from planner.runs where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid`.execute(
        db,
      )
    ).rows[0];
    return row
      ? {
          id: row.id,
          status: row.status,
          legacyUnproved: row.legacy_unproved,
          ...(row.normal_wake_id ? { normalWakeId: row.normal_wake_id } : {}),
          ...(row.recording_account_id ? { accountId: row.recording_account_id } : {}),
          ...(row.recording_generation !== null ? { generation: row.recording_generation } : {}),
        }
      : undefined;
  },
  async retire(scope, id) {
    const { db, u, e } = identity(scope);
    const result =
      await sql`update planner.runs set status='stale',outcome='recording_revoked',claim_id=null,claim_until=null,normal_wake_id=null,claim_wake_claim_id=null,updated_at=now()
   where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid and status in('queued','prepared','unknown','blocked') returning id`.execute(
        db,
      );
    return result.rows.length === 1;
  },
  state: (scope) => state(scope, true),
  stateHeader: (scope) => state(scope, false),
  async root(cap) {
    const row = (
      await sql<{
        account_id: string;
        revision: number;
      }>`select account_id,revision from identity.universes where id=${cap.personal.authority.universeId}::uuid and privacy_epoch=${cap.personal.authority.privacyEpoch} and recording_on and recording_generation=${cap.generation}`.execute(
        recordingTransactionOf(cap),
      )
    ).rows[0];
    if (!row) throw new Error('PLANNER_RECORDING_ROOT_INVALID');
    return { accountId: row.account_id, revision: row.revision };
  },
  async writeState(scope, s: PlannerState) {
    const { db, u, e } = identity(scope),
      o = s.desiredSource;
    await sql`insert into planner.state(universe_id,privacy_epoch,desired_revision,material_revision,accepted_revision,active_run_id,intent,desired_recording_generation,desired_origin_kind,desired_origin_command_id,desired_origin_source_revision)
    values(${u}::uuid,${e},${s.desiredRevision},${s.materialRevision},${s.acceptedRevision},${s.activeRunId ?? null}::uuid,${s.intent ? JSON.stringify(s.intent) : null}::jsonb,${o?.generation ?? null},${o?.kind ?? null},${o?.kind === 'command' ? o.commandId : null}::uuid,${o?.kind === 'material' ? o.sourceRevision : null})
    on conflict(universe_id,privacy_epoch) do update set desired_revision=excluded.desired_revision,material_revision=excluded.material_revision,accepted_revision=excluded.accepted_revision,active_run_id=excluded.active_run_id,intent=coalesce(excluded.intent,planner.state.intent),desired_recording_generation=excluded.desired_recording_generation,desired_origin_kind=excluded.desired_origin_kind,desired_origin_command_id=excluded.desired_origin_command_id,desired_origin_source_revision=excluded.desired_origin_source_revision`.execute(
      db,
    );
  },
  async header(scope, id) {
    const { db, u, e } = identity(scope);
    const row = (
      await sql<
        SourceRow & {
          id: string;
          revision: number;
          status: PlannerRun['status'];
          claim_id: string | null;
          claim_until: Date | null;
          has_context: boolean;
          outcome: string | null;
          recording_account_id: string | null;
          recording_context_sha256: string | null;
          recording_model_context_sha256: string | null;
          normal_wake_id: string | null;
          claim_wake_claim_id: string | null;
        }
      >`
   select id,revision,status,claim_id,claim_until,context is not null as has_context,outcome,recording_account_id,recording_generation as generation,recording_origin_kind as origin_kind,recording_origin_command_id as origin_command_id,recording_origin_source_revision as origin_source_revision,recording_context_sha256,recording_model_context_sha256,normal_wake_id,claim_wake_claim_id
   from planner.runs where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid`.execute(db)
    ).rows[0];
    if (!row) return undefined;
    const origin = source(row);
    if (Boolean(origin) !== Boolean(row.recording_account_id)) throw new Error('PLANNER_SOURCE_INVALID');
    return {
      id: row.id,
      revision: row.revision,
      status: row.status,
      hasContext: row.has_context,
      hasRecordingMetadata: [
        row.recording_account_id,
        row.generation,
        row.origin_kind,
        row.origin_command_id,
        row.origin_source_revision,
        row.recording_context_sha256,
        row.recording_model_context_sha256,
      ].some((x) => x !== null),
      ...(row.claim_id && row.claim_until ? { claimId: row.claim_id, claimUntil: row.claim_until.toISOString() } : {}),
      ...(row.outcome ? { outcome: row.outcome } : {}),
      ...(origin && row.recording_account_id
        ? { recording: { accountId: row.recording_account_id, source: origin } }
        : {}),
      ...(row.recording_context_sha256 ? { contextSha256: row.recording_context_sha256 } : {}),
      ...(row.recording_model_context_sha256 ? { modelContextSha256: row.recording_model_context_sha256 } : {}),
      ...(row.normal_wake_id ? { normalWakeId: row.normal_wake_id } : {}),
      ...(row.claim_wake_claim_id ? { claimWakeClaimId: row.claim_wake_claim_id } : {}),
    };
  },
  async context(scope, id) {
    const { db, u, e } = identity(scope);
    return (
      (
        await sql<{
          context: FrozenContext | null;
        }>`select context from planner.runs where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid`.execute(
          db,
        )
      ).rows[0]?.context ?? undefined
    );
  },
  async writeRun(scope, r) {
    const { db, u, e } = identity(scope),
      o = r.recording?.source;
    await sql`insert into planner.runs(universe_id,privacy_epoch,id,revision,status,claim_id,claim_until,context_version,context,outcome,recording_account_id,recording_generation,recording_origin_kind,recording_origin_command_id,recording_origin_source_revision,recording_context_sha256,recording_model_context_sha256,normal_wake_id,claim_wake_claim_id)
   values(${u}::uuid,${e},${r.id}::uuid,${r.revision},${r.status},${r.claimId ?? null}::uuid,${r.claimUntil ?? null}::timestamptz,${r.context?.version ?? null},${r.context ? JSON.stringify(r.context) : null}::jsonb,${r.outcome ?? null},${r.recording?.accountId ?? null}::uuid,${o?.generation ?? null},${o?.kind ?? null},${o?.kind === 'command' ? o.commandId : null}::uuid,${o?.kind === 'material' ? o.sourceRevision : null},${r.contextSha256 ?? null},${r.modelContextSha256 ?? null},${r.normalWakeId ?? null}::uuid,${r.claimWakeClaimId ?? null}::uuid)
   on conflict(universe_id,id) do update set revision=excluded.revision,status=excluded.status,claim_id=excluded.claim_id,claim_until=excluded.claim_until,context_version=coalesce(excluded.context_version,planner.runs.context_version),context=coalesce(excluded.context,planner.runs.context),outcome=excluded.outcome,recording_account_id=excluded.recording_account_id,recording_generation=excluded.recording_generation,recording_origin_kind=excluded.recording_origin_kind,recording_origin_command_id=excluded.recording_origin_command_id,recording_origin_source_revision=excluded.recording_origin_source_revision,recording_context_sha256=coalesce(excluded.recording_context_sha256,planner.runs.recording_context_sha256),recording_model_context_sha256=coalesce(excluded.recording_model_context_sha256,planner.runs.recording_model_context_sha256),normal_wake_id=excluded.normal_wake_id,claim_wake_claim_id=excluded.claim_wake_claim_id,updated_at=now()`.execute(
      db,
    );
  },
  async revisions(scope, limit) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw new Error('PLANNER_MEMORY_BOUNDS');
    const { db, u, e } = identity(scope);
    const rows = (
      await sql<{
        revision: number;
        context_revision: number;
        run_id: string;
        opportunities: unknown[];
      }>`select revision,context_revision,run_id,opportunities from planner.revisions where universe_id=${u}::uuid and privacy_epoch=${e} order by revision desc limit ${limit}`.execute(
        db,
      )
    ).rows;
    return rows.map((r) => ({
      revision: r.revision,
      contextRevision: r.context_revision,
      runId: r.run_id,
      opportunities: r.opportunities.map((x) => OpportunitySchema.parse(x)),
    }));
  },
  async accept(scope, run, opportunities, attemptId) {
    if (!run.context) throw new Error('PLANNER_CONTEXT_MISSING');
    const { db, u, e } = identity(scope);
    await sql`insert into planner.revisions(universe_id,privacy_epoch,revision,run_id,context_revision,attempt_id,policy_version,opportunities) values(${u}::uuid,${e},${run.revision},${run.id}::uuid,${run.context.contextRevision},${attemptId}::uuid,'personal-planner.v0',${JSON.stringify(opportunities)}::jsonb)`.execute(
      db,
    );
  },
};
