import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { cutroomTransactionOf, cutroomAccountingTransactionOf } from '../../infrastructure/postgres/cutroom-scope.js';
import type { EnqueueCutroom, EnqueueCutroomAccounting } from '../../infrastructure/jobs/enqueue-cutroom.js';
import type { CutroomExecutionStore } from '../application/cutroom-execution-ports.js';
import type { AttemptState } from '../domain/attempts.js';
import { cutroomFollowQueue } from '../events.js';
export function postgresCutroomExecution(
  enqueue: EnqueueCutroom,
  enqueueAccounting: EnqueueCutroomAccounting,
  now: () => Date = () => new Date(),
): CutroomExecutionStore {
  return {
    async matchesAccountingObservation(scope, observationId, snapshotSha256, runId) {
      const trx = cutroomAccountingTransactionOf(scope);
      const observation = {
        requestId: scope.identity.requestId,
        runId,
        evidenceSha256: snapshotSha256,
        outcome: 'terminal_unvalidated',
      };
      const expectedProjection = createHash('sha256').update(JSON.stringify(observation), 'utf8').digest('hex');
      const row = await trx
        .selectFrom('reasoning.cutroom_observations as o')
        .innerJoin('reasoning.cutroom_accounting_intents as i', (join) =>
          join.onRef('i.observation_id', '=', 'o.id').onRef('i.attempt_id', '=', 'o.attempt_id'),
        )
        .select('o.id')
        .where('o.id', '=', observationId)
        .where('o.attempt_id', '=', scope.attemptId)
        .where('o.request_id', '=', scope.identity.requestId)
        .where('o.run_id', '=', runId)
        .where('o.evidence_sha256', '=', snapshotSha256)
        .where('o.projection_sha256', '=', expectedProjection)
        .where('o.outcome', '=', 'terminal_unvalidated')
        .where('i.state', '=', 'pending')
        .executeTakeFirst();
      return row !== undefined;
    },
    async readAccountingBinding(scope) {
      const trx = cutroomAccountingTransactionOf(scope);
      const row = await trx
        .selectFrom('reasoning.cutroom_execution as e')
        .innerJoin('reasoning.cutroom_attempts as a', 'a.id', 'e.attempt_id')
        .select([
          'e.dispatch_id',
          'e.fence',
          'e.request_sha256',
          'e.review_sha256',
          'e.corpus_sha256',
          'e.human_evidence_ref',
          'e.profile_sha256',
          'e.sole_writer_evidence_sha256',
          'e.funds_evidence_sha256',
          'e.binding_id',
          'a.binding_id as retained_binding_id',
          'a.pool_state',
          sql<string>`to_char(e.claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('claimed'),
          sql<string>`to_char(e.bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('bound'),
          sql<string>`to_char(a.claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('retained_claimed'),
          sql<string>`to_char(a.bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as('retained_bound'),
        ])
        .where('e.attempt_id', '=', scope.attemptId)
        .where('e.world_id', '=', scope.worldId)
        .where('e.business_run_id', '=', scope.businessRunId)
        .where('a.world_id', '=', scope.worldId)
        .where('a.business_run_id', '=', scope.businessRunId)
        .executeTakeFirst();
      if (
        !row ||
        row.fence !== scope.fence ||
        row.request_sha256 !== scope.identity.requestSha256 ||
        row.pool_state !== 'claimed' ||
        row.binding_id !== row.retained_binding_id ||
        row.claimed !== row.retained_claimed ||
        row.bound !== row.retained_bound
      )
        return undefined;
      return {
        dispatchId: row.dispatch_id,
        fence: row.fence,
        requestSha256: row.request_sha256,
        reviewSha256: row.review_sha256,
        corpusSha256: row.corpus_sha256,
        humanEvidenceRef: row.human_evidence_ref,
        profileSha256: row.profile_sha256,
        soleWriterEvidenceSha256: row.sole_writer_evidence_sha256,
        fundsEvidenceSha256: row.funds_evidence_sha256,
        poolReceipt: { bindingId: row.binding_id, claimedAt: row.claimed, boundAt: row.bound },
      };
    },
    async identify(scope, attemptId) {
      const trx = cutroomTransactionOf(scope);
      const a = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .select(['business_run_id', 'state'])
        .where('world_id', '=', scope.authority.worldId)
        .where('id', '=', attemptId)
        .executeTakeFirst();
      if (!a) return undefined;
      const c = await trx
        .selectFrom('content.reel_commissions')
        .select('attempt_id')
        .where('world_id', '=', scope.authority.worldId)
        .where('business_run_id', '=', a.business_run_id)
        .forUpdate()
        .executeTakeFirst();
      return c?.attempt_id === attemptId
        ? { businessRunId: a.business_run_id, state: a.state as AttemptState }
        : undefined;
    },
    async lock(scope, attemptId) {
      const trx = cutroomTransactionOf(scope);
      const identity = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .select('business_run_id')
        .where('world_id', '=', scope.authority.worldId)
        .where('id', '=', attemptId)
        .executeTakeFirst();
      if (!identity) return undefined;
      const c = await trx
        .selectFrom('content.reel_commissions')
        .selectAll()
        .where('world_id', '=', scope.authority.worldId)
        .where('business_run_id', '=', identity.business_run_id)
        .forUpdate()
        .executeTakeFirst();
      const a = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .selectAll()
        .where('id', '=', attemptId)
        .where('world_id', '=', scope.authority.worldId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !a ||
        !c ||
        c.attempt_id !== a.id ||
        a.generation !== scope.authority.generation ||
        c.generation !== a.generation ||
        c.script_sha256 !== a.script_sha256 ||
        c.evidence_sha256 !== a.evidence_sha256 ||
        c.request_sha256 !== a.request_sha256 ||
        c.approval_ref !== a.approval_ref ||
        c.take !== a.take ||
        c.ceiling_cents !== a.ceiling_cents ||
        c.request_id !== a.request_id
      )
        return undefined;
      const r = await sql<{
        claimed: string;
        bound: string;
      }>`select to_char(claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') claimed,to_char(bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') bound from reasoning.cutroom_attempts where id=${attemptId}::uuid`.execute(
        trx,
      );
      return {
        attemptId: a.id,
        businessRunId: a.business_run_id,
        requestSha256: a.request_sha256,
        state: a.state as AttemptState,
        fence: a.fence,
        ceilingCents: a.ceiling_cents,
        poolReceipt:
          a.pool_state === 'claimed' && a.binding_id
            ? { bindingId: a.binding_id, claimedAt: r.rows[0]!.claimed, boundAt: r.rows[0]!.bound }
            : null,
      };
    },
    async intent(scope, attemptId, review, p) {
      const trx = cutroomTransactionOf(scope),
        date = now();
      if (Date.parse(p.expiresAt) < date.getTime()) return undefined;
      const request = await trx
        .selectFrom('reasoning.cutroom_requests')
        .selectAll()
        .where('attempt_id', '=', attemptId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !request ||
        request.request_utf8 === null ||
        new Date(request.expires_at).getTime() <= date.getTime() ||
        request.request_sha256 !== p.requestSha256 ||
        request.byte_length !== Buffer.byteLength(request.request_utf8, 'utf8') ||
        request.request_sha256 !== createHash('sha256').update(request.request_utf8, 'utf8').digest('hex')
      )
        return undefined;
      const a = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .selectAll()
        .where('id', '=', attemptId)
        .executeTakeFirstOrThrow();
      if (
        !scope.enabled ||
        a.state !== 'reserved' ||
        a.dispatch_intent_at !== null ||
        a.fence !== p.fence ||
        a.fence >= 2147483647 ||
        a.pool_state !== 'claimed' ||
        a.binding_id !== p.poolReceipt.bindingId
      )
        throw new Error('CUTROOM_DISPATCH_FENCED');
      const dispatchId = randomUUID();
      await trx
        .insertInto('reasoning.cutroom_execution')
        .values({
          attempt_id: attemptId,
          world_id: scope.authority.worldId,
          business_run_id: a.business_run_id,
          dispatch_id: dispatchId,
          request_sha256: p.requestSha256,
          fence: a.fence + 1,
          review_sha256: review.reviewSha256,
          corpus_sha256: review.corpusSha256,
          human_evidence_ref: review.humanEvidenceRef,
          profile_sha256: p.profileSha256,
          sole_writer_evidence_sha256: p.soleWriterEvidenceSha256,
          funds_evidence_sha256: p.fundsEvidenceSha256,
          preflight_observed_at: p.observedAt,
          preflight_expires_at: p.expiresAt,
          available_cents: p.availableCents,
          binding_id: p.poolReceipt.bindingId,
          claimed_at: p.poolReceipt.claimedAt,
          bound_at: p.poolReceipt.boundAt,
          follow_until: new Date(date.getTime() + 30 * 86400000),
        })
        .execute();
      await trx
        .updateTable('reasoning.cutroom_attempts')
        .set({ state: 'dispatched', dispatch_intent_at: date, fence: a.fence + 1 })
        .where('id', '=', attemptId)
        .execute();
      await enqueue(scope, cutroomFollowQueue, {
        v: 1,
        worldId: scope.authority.worldId,
        attemptId,
        businessRunId: a.business_run_id,
        dispatchId,
      });
      return { dispatchId, requestUtf8: request.request_utf8, requestSha256: p.requestSha256 };
    },
    async markUnknown(scope, attemptId) {
      await cutroomTransactionOf(scope)
        .updateTable('reasoning.cutroom_attempts')
        .set({ state: 'unknown' })
        .where('id', '=', attemptId)
        .where('state', '=', 'dispatched')
        .execute();
    },
    async observe(scope, o) {
      const trx = cutroomAccountingTransactionOf(scope),
        projectionSha = createHash('sha256').update(JSON.stringify(o), 'utf8').digest('hex');
      const old = await trx
        .selectFrom('reasoning.cutroom_observations')
        .selectAll()
        .where('attempt_id', '=', scope.attemptId)
        .where('evidence_sha256', '=', o.evidenceSha256)
        .executeTakeFirst();
      if (old) {
        if (old.projection_sha256 !== projectionSha) throw new Error('CUTROOM_OBSERVATION_CONTRADICTION');
        return { kind: 'pending', observationId: old.id };
      }
      const id = randomUUID();
      await trx
        .insertInto('reasoning.cutroom_observations')
        .values({
          id,
          attempt_id: scope.attemptId,
          request_id: o.requestId,
          run_id: o.runId,
          evidence_sha256: o.evidenceSha256,
          projection_sha256: projectionSha,
          outcome: o.outcome,
          observed_generation: scope.currentGeneration,
        })
        .execute();
      await trx
        .insertInto('reasoning.cutroom_accounting_intents')
        .values({ attempt_id: scope.attemptId, observation_id: id, state: 'pending' })
        .execute();
      await enqueueAccounting(scope, {
        v: 1,
        worldId: scope.worldId,
        attemptId: scope.attemptId,
        businessRunId: scope.businessRunId,
        observationId: id,
      });
      return { kind: 'pending', observationId: id };
    },
  };
}
