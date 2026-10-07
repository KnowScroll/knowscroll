/** #199: the shared Reel pool's spend record (the separate `knowscroll_pool` database, see
 * `packages/db/pool-migrations/`). Worlds reach it only through its SECURITY DEFINER functions:
 * claim a request id before ordering, settle it with what the run really cost, release a claim
 * that was never sent, and read the orders every world receives from. The database's own rules
 * are the authority; nothing here adds one. */
import { resolve } from 'node:path';
import type pg from 'pg';
import { type MigrationResult, runMigrations } from '../migrations.ts';

type PoolStage = 'plan' | 'stills' | 'video';
type PoolOutcome = 'completed' | 'refused' | 'stopped' | 'failed' | 'cancelled';

type PoolClaimInput = {
  requestId: string;
  scriptDigest: string;
  take: number;
  until: PoolStage;
  bodySha256: string;
  world: string;
  ceilingCents: number;
  approvalRef: string;
};
type PoolClaimOutcome =
  | { status: 'claimed'; requestId: string }
  | { status: 'already_ordered'; requestId: string; orderedBy: string }
  | { status: 'cap_exceeded' }
  | { status: 'take_taken' };

type PoolOrder = {
  requestId: string;
  scriptDigest: string;
  take: number;
  until: PoolStage;
  bodySha256: string;
  orderedBy: string;
  ceilingCents: number;
  approvalRef: string;
  state: 'claimed' | 'settled' | 'released';
  outcome: PoolOutcome | null;
  spentCents: number | null;
  finalRunId: string | null;
  claimedAt: Date;
  settledAt: Date | null;
};

type PoolBudget = {
  capCents: number;
  committedCents: number;
  leftCents: number;
};

export type PoolLedger = {
  nextTake(scriptDigest: string): Promise<number>;
  claim(input: PoolClaimInput): Promise<PoolClaimOutcome>;
  settle(input: {
    requestId: string;
    world: string;
    outcome: PoolOutcome;
    spentCents: number;
    finalRunId: string | null;
  }): Promise<'settled' | 'already_settled'>;
  release(
    requestId: string,
    world: string,
  ): Promise<'released' | 'already_released'>;
  orders(): Promise<PoolOrder[]>;
  budget(): Promise<PoolBudget>;
};

export function createPoolLedger(db: pg.Pool): PoolLedger {
  return {
    async nextTake(scriptDigest) {
      const row = (
        await db.query<{ take: number }>('SELECT pool_next_take($1) AS take', [
          scriptDigest,
        ])
      ).rows[0];
      if (!row) throw new Error('pool_next_take returned nothing');
      return row.take;
    },
    async claim(input) {
      const row = (
        await db.query<{
          status: string;
          request_id: string | null;
          ordered_by: string | null;
        }>(
          'SELECT status,request_id,ordered_by FROM pool_claim($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            input.requestId,
            input.scriptDigest,
            input.take,
            input.until,
            input.bodySha256,
            input.world,
            input.ceilingCents,
            input.approvalRef,
          ],
        )
      ).rows[0];
      if (!row) throw new Error('pool_claim returned nothing');
      if (row.status === 'claimed')
        return { status: 'claimed', requestId: input.requestId };
      if (row.status === 'already_ordered' && row.request_id && row.ordered_by)
        return {
          status: 'already_ordered',
          requestId: row.request_id,
          orderedBy: row.ordered_by,
        };
      if (row.status === 'cap_exceeded') return { status: 'cap_exceeded' };
      if (row.status === 'take_taken') return { status: 'take_taken' };
      throw new Error(`pool_claim answered ${row.status}`);
    },
    async settle(input) {
      const row = (
        await db.query<{ status: 'settled' | 'already_settled' }>(
          'SELECT pool_settle($1,$2,$3,$4,$5) AS status',
          [
            input.requestId,
            input.world,
            input.outcome,
            input.spentCents,
            input.finalRunId,
          ],
        )
      ).rows[0];
      if (!row) throw new Error('pool_settle returned nothing');
      return row.status;
    },
    async release(requestId, world) {
      const row = (
        await db.query<{ status: 'released' | 'already_released' }>(
          'SELECT pool_release($1,$2) AS status',
          [requestId, world],
        )
      ).rows[0];
      if (!row) throw new Error('pool_release returned nothing');
      return row.status;
    },
    async orders() {
      const rows = (
        await db.query<{
          request_id: string;
          script_digest: string;
          take: number;
          until: PoolStage;
          body_sha256: string;
          ordered_by: string;
          ceiling_cents: number;
          approval_ref: string;
          state: 'claimed' | 'settled' | 'released';
          outcome: PoolOutcome | null;
          spent_cents: number | null;
          final_run_id: string | null;
          claimed_at: Date;
          settled_at: Date | null;
        }>('SELECT * FROM pool_orders()')
      ).rows;
      return rows.map((row) => ({
        requestId: row.request_id,
        scriptDigest: row.script_digest,
        take: row.take,
        until: row.until,
        bodySha256: row.body_sha256,
        orderedBy: row.ordered_by,
        ceilingCents: row.ceiling_cents,
        approvalRef: row.approval_ref,
        state: row.state,
        outcome: row.outcome,
        spentCents: row.spent_cents,
        finalRunId: row.final_run_id,
        claimedAt: row.claimed_at,
        settledAt: row.settled_at,
      }));
    },
    async budget() {
      const row = (
        await db.query<{
          cap_cents: number;
          committed_cents: number;
          left_cents: number;
        }>('SELECT * FROM pool_budget_status()')
      ).rows[0];
      if (!row) throw new Error('pool_budget_status returned nothing');
      return {
        capCents: row.cap_cents,
        committedCents: row.committed_cents,
        leftCents: row.left_cents,
      };
    },
  };
}

/** Applies the pool database's own migrations (a separate directory and database). */
export async function runPoolMigrations(
  db: pg.Pool,
  directory = resolve('packages/db/pool-migrations'),
): Promise<MigrationResult> {
  return runMigrations(db, { directory });
}
