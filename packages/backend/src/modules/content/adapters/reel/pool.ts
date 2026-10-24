import type pg from 'pg';
import { assertOutsideTransaction } from '../../../../infrastructure/postgres/transaction-marker.js';
import type { RunOutcome } from '../../domain/reel/chain.js';
import type { PoolBudget, PoolClaimResult, PoolOrder, ReelPool } from '../../application/reel/ports.js';

type Queryable = Pick<pg.Pool, 'query'>;

interface OrderRow {
  readonly request_id: string;
  readonly script_digest: string;
  readonly take: number;
  readonly body_sha256: string;
  readonly ordered_by: string;
  readonly ceiling_cents: number;
  readonly state: 'claimed' | 'settled' | 'released';
  readonly outcome: RunOutcome | null;
  readonly spent_cents: number | null;
  readonly final_run_id: string | null;
}

/**
 * The shared Reel pool (`knowscroll_pool`, ADR-0050) through its own SECURITY DEFINER functions
 * (`ops/pool/migrations/0001`): the tables are never read or written directly. Every call is one
 * autocommitted statement, made outside any world transaction. A refused claim is an answer; a
 * pool that cannot be reached throws, and the caller treats that as "unknown".
 */
export function poolOfSharedPool(database: Queryable): ReelPool {
  return {
    async nextTake(scriptSha256) {
      assertOutsideTransaction('reel.pool');
      const { rows } = await database.query<{ take: number }>('select pool_next_take($1) as take', [scriptSha256]);
      return Number(rows[0]!.take);
    },

    async claim(identity): Promise<PoolClaimResult> {
      assertOutsideTransaction('reel.pool');
      const { rows } = await database.query<{ status: string; request_id: string | null; ordered_by: string | null }>(
        'select status, request_id, ordered_by from pool_claim($1,$2,$3,$4,$5,$6,$7,$8)',
        [
          identity.requestId,
          identity.scriptSha256,
          identity.take,
          'video',
          identity.requestSha256,
          identity.world,
          identity.ceilingCents,
          identity.approvalRef,
        ],
      );
      const answer = rows[0]!;
      switch (answer.status) {
        case 'claimed':
          return { kind: 'claimed' };
        case 'already_ordered':
          return { kind: 'already_ordered', requestId: answer.request_id ?? '', orderedBy: answer.ordered_by ?? '' };
        case 'cap_exceeded':
          return { kind: 'cap_exceeded' };
        case 'take_taken':
          return { kind: 'take_taken' };
        default:
          throw new Error('REEL_POOL_UNKNOWN_CLAIM_ANSWER');
      }
    },

    async settle(settlement) {
      assertOutsideTransaction('reel.pool');
      const { rows } = await database.query<{ result: 'settled' | 'already_settled' }>(
        'select pool_settle($1,$2,$3,$4,$5) as result',
        [settlement.requestId, settlement.world, settlement.outcome, settlement.spentCents, settlement.finalRunId],
      );
      return rows[0]!.result;
    },

    async release(requestId, world) {
      assertOutsideTransaction('reel.pool');
      const { rows } = await database.query<{ result: 'released' | 'already_released' }>(
        'select pool_release($1,$2) as result',
        [requestId, world],
      );
      return rows[0]!.result;
    },

    async orders(): Promise<readonly PoolOrder[]> {
      assertOutsideTransaction('reel.pool');
      const { rows } = await database.query<OrderRow>('select * from pool_orders()');
      return rows.map((row) => ({
        requestId: row.request_id,
        scriptSha256: row.script_digest,
        take: row.take,
        requestSha256: row.body_sha256,
        orderedBy: row.ordered_by,
        ceilingCents: row.ceiling_cents,
        state: row.state,
        outcome: row.outcome,
        spentCents: row.spent_cents,
        finalRunId: row.final_run_id,
      }));
    },

    async budget(): Promise<PoolBudget> {
      assertOutsideTransaction('reel.pool');
      const { rows } = await database.query<{ cap_cents: number; committed_cents: number; left_cents: number }>(
        'select cap_cents, committed_cents, left_cents from pool_budget_status()',
      );
      const row = rows[0]!;
      return { capCents: row.cap_cents, committedCents: row.committed_cents, leftCents: row.left_cents };
    },
  };
}
