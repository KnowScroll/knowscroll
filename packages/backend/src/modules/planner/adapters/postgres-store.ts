import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PlannerStore, PlannerState, PlannerRun, FrozenContext } from '../application/ports.js';
import { IntentSchema, OpportunitySchema } from '../domain/proposal.js';
const identity = (s: Parameters<PlannerStore['state']>[0]) => ({
  db: transactionOf(s),
  u: s.authority.universeId,
  e: s.authority.privacyEpoch,
});
export const plannerStore: PlannerStore = {
  async state(scope) {
    const { db, u, e } = identity(scope);
    const row = (
      await sql<{
        desired_revision: number;
        material_revision: number;
        accepted_revision: number;
        active_run_id: string | null;
        intent: unknown;
      }>`select desired_revision,material_revision,accepted_revision,active_run_id,intent from planner.state where universe_id=${u}::uuid and privacy_epoch=${e}`.execute(
        db,
      )
    ).rows[0];
    return row
      ? {
          desiredRevision: row.desired_revision,
          materialRevision: row.material_revision,
          acceptedRevision: row.accepted_revision,
          ...(row.active_run_id ? { activeRunId: row.active_run_id } : {}),
          ...(row.intent ? { intent: IntentSchema.parse(row.intent) } : {}),
        }
      : { desiredRevision: 0, materialRevision: 0, acceptedRevision: 0 };
  },
  async writeState(scope, state: PlannerState) {
    const { db, u, e } = identity(scope);
    await sql`insert into planner.state(universe_id,privacy_epoch,desired_revision,material_revision,accepted_revision,active_run_id,intent) values(${u}::uuid,${e},${state.desiredRevision},${state.materialRevision},${state.acceptedRevision},${state.activeRunId ?? null}::uuid,${state.intent ? JSON.stringify(state.intent) : null}::jsonb) on conflict(universe_id,privacy_epoch) do update set desired_revision=excluded.desired_revision,material_revision=excluded.material_revision,accepted_revision=excluded.accepted_revision,active_run_id=excluded.active_run_id,intent=excluded.intent`.execute(
      db,
    );
  },
  async run(scope, id) {
    const { db, u, e } = identity(scope);
    const row = (
      await sql<{
        id: string;
        revision: number;
        status: PlannerRun['status'];
        claim_id: string | null;
        claim_until: Date | null;
        context: FrozenContext | null;
        outcome: string | null;
      }>`select id,revision,status,claim_id,claim_until,context,outcome from planner.runs where universe_id=${u}::uuid and privacy_epoch=${e} and id=${id}::uuid`.execute(
        db,
      )
    ).rows[0];
    return row
      ? {
          id: row.id,
          revision: row.revision,
          status: row.status,
          ...(row.claim_id && row.claim_until
            ? { claimId: row.claim_id, claimUntil: row.claim_until.toISOString() }
            : {}),
          ...(row.context ? { context: row.context } : {}),
          ...(row.outcome ? { outcome: row.outcome } : {}),
        }
      : undefined;
  },
  async writeRun(scope, run) {
    const { db, u, e } = identity(scope);
    await sql`insert into planner.runs(universe_id,privacy_epoch,id,revision,status,claim_id,claim_until,context_version,context,outcome) values(${u}::uuid,${e},${run.id}::uuid,${run.revision},${run.status},${run.claimId ?? null}::uuid,${run.claimUntil ?? null}::timestamptz,${run.context?.version ?? null},${run.context ? JSON.stringify(run.context) : null}::jsonb,${run.outcome ?? null}) on conflict(universe_id,id) do update set revision=excluded.revision,status=excluded.status,claim_id=excluded.claim_id,claim_until=excluded.claim_until,context_version=excluded.context_version,context=excluded.context,outcome=excluded.outcome,updated_at=now()`.execute(
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
