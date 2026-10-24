import { sql, type Kysely, type RawBuilder } from 'kysely';
import type { Database } from '../../../../infrastructure/postgres/database.js';
import type { RunOutcome } from '../../domain/reel/chain.js';
import type {
  AttemptMove,
  AttemptState,
  FinishedFacts,
  PoolState,
  ReelAttemptRecord,
  ReelLedger,
  ReelOrderRecord,
} from '../../application/reel/ports.js';

interface OrderRow {
  id: string;
  script_name: string;
  recipe_key: string;
  until: 'plan' | 'video';
  script_sha256: string;
  approval_ref: string;
  asset_id: string | null;
}

interface AttemptRow {
  id: string;
  order_id: string;
  take: number;
  paid: boolean;
  request_id: string;
  request_utf8: string;
  request_sha256: string;
  ceiling_cents: number;
  state: AttemptState;
  outcome_code: string | null;
  run_id: string | null;
  pool_state: PoolState;
  remote_outcome: RunOutcome | null;
  remote_cost_cents: number | null;
  final_run_id: string | null;
  run_ids: string[] | null;
  remote_detail: string | null;
}

const orderOf = (row: OrderRow): ReelOrderRecord => ({
  id: row.id,
  scriptName: row.script_name,
  recipeKey: row.recipe_key,
  until: row.until,
  scriptSha256: row.script_sha256,
  approvalRef: row.approval_ref,
  assetId: row.asset_id,
});

const finishedOf = (row: AttemptRow): FinishedFacts | null =>
  row.remote_outcome === null
    ? null
    : {
        outcome: row.remote_outcome,
        costCents: row.remote_cost_cents!,
        finalRunId: row.final_run_id!,
        runIds: row.run_ids!,
        detail: row.remote_detail,
      };

const attemptOf = (row: AttemptRow): ReelAttemptRecord => ({
  id: row.id,
  orderId: row.order_id,
  take: row.take,
  paid: row.paid,
  requestId: row.request_id,
  requestUtf8: row.request_utf8,
  requestSha256: row.request_sha256,
  ceilingCents: row.ceiling_cents,
  state: row.state,
  outcomeCode: row.outcome_code,
  runId: row.run_id,
  poolState: row.pool_state,
  finished: finishedOf(row),
});

/** The `where` and `set` of one move: each starts from the state it names and from no other. */
function updateOf(move: AttemptMove): { readonly set: RawBuilder<unknown>; readonly when: RawBuilder<unknown> } {
  switch (move.kind) {
    case 'claimed':
      return { set: sql`pool_state = 'claimed'`, when: sql`state = 'reserved' and paid and pool_state = 'none'` };
    case 'not_sent':
      return { set: sql`state = 'not_sent', outcome_code = ${move.code}`, when: sql`state = 'reserved'` };
    case 'dispatching':
      return {
        set: sql`state = 'dispatched', dispatched_at = clock_timestamp()`,
        when: sql`state = 'reserved' and (not paid or pool_state = 'claimed')`,
      };
    case 'accepted':
      return { set: sql`state = 'succeeded', run_id = ${move.runId}`, when: sql`state = 'dispatched'` };
    case 'refused':
      return { set: sql`state = 'failed', outcome_code = ${move.code}`, when: sql`state = 'dispatched'` };
    case 'unknown':
      return { set: sql`state = 'unknown', outcome_code = ${move.code}`, when: sql`state = 'dispatched'` };
    case 'reconciled':
      return { set: sql`state = 'reconciled', run_id = ${move.runId}`, when: sql`state = 'unknown'` };
    case 'written_off':
      return {
        set: sql`state = 'written_off', operator_note = ${move.reason.slice(0, 300)}`,
        when: sql`state = 'unknown'`,
      };
    case 'finished':
      return {
        set: sql`remote_outcome = ${move.facts.outcome}, remote_cost_cents = ${move.facts.costCents},
          final_run_id = ${move.facts.finalRunId}, run_ids = ${move.facts.runIds},
          remote_detail = ${move.facts.detail}, finished_at = clock_timestamp()`,
        when: sql`state in ('succeeded', 'reconciled') and remote_outcome is null`,
      };
    case 'settled':
      return {
        set: sql`pool_state = 'settled', settled_at = clock_timestamp()`,
        when: sql`pool_state = 'claimed' and remote_outcome is not null`,
      };
    case 'released':
      return {
        set: sql`pool_state = 'released'`,
        when: sql`pool_state = 'claimed' and state in ('not_sent', 'failed')`,
      };
  }
}

/**
 * The world's record of Reel orders and attempts (`content.reel_orders`, `content.reel_attempts`).
 * Every method is one short statement or transaction; nothing here waits on Cutroom or the pool.
 * The table's own triggers refuse a move that goes backwards, so this adapter cannot weaken them.
 */
export function postgresReelLedger(db: Kysely<Database>, newId: () => string): ReelLedger {
  return {
    async ensureOrder(order) {
      await sql`insert into content.reel_orders (id, script_name, recipe_key, until, script_sha256, approval_ref)
        values (${newId()}::uuid, ${order.scriptName}, ${order.recipeKey}, ${order.until}, ${order.scriptSha256}, ${order.approvalRef})
        on conflict (script_sha256) do nothing`.execute(db);
      const { rows } =
        await sql<OrderRow>`select * from content.reel_orders where script_sha256 = ${order.scriptSha256}`.execute(db);
      return orderOf(rows[0]!);
    },

    async findOrder(scriptSha256) {
      const { rows } =
        await sql<OrderRow>`select * from content.reel_orders where script_sha256 = ${scriptSha256}`.execute(db);
      return rows[0] === undefined ? undefined : orderOf(rows[0]);
    },

    async attemptsOf(orderId) {
      const { rows } =
        await sql<AttemptRow>`select * from content.reel_attempts where order_id = ${orderId}::uuid order by take`.execute(
          db,
        );
      return rows.map(attemptOf);
    },

    async readAttempt(attemptId) {
      const { rows } = await sql<AttemptRow>`select * from content.reel_attempts where id = ${attemptId}::uuid`.execute(
        db,
      );
      return rows[0] === undefined ? undefined : attemptOf(rows[0]);
    },

    async reserve(attempt) {
      const { rows } = await sql<AttemptRow>`insert into content.reel_attempts
          (id, order_id, take, paid, request_id, request_utf8, request_sha256, ceiling_cents)
        values (${newId()}::uuid, ${attempt.orderId}::uuid, ${attempt.take}, ${attempt.paid}, ${attempt.requestId},
          ${attempt.requestUtf8}, ${attempt.requestSha256}, ${attempt.ceilingCents})
        on conflict do nothing returning *`.execute(db);
      return rows[0] === undefined ? undefined : attemptOf(rows[0]);
    },

    async advance(attemptId, move) {
      const { set, when } = updateOf(move);
      const { rows } = await sql<AttemptRow>`update content.reel_attempts set ${set}
        where id = ${attemptId}::uuid and ${when} returning *`.execute(db);
      return rows[0] === undefined ? undefined : attemptOf(rows[0]);
    },

    async listOrders() {
      const orders = await sql<OrderRow>`select * from content.reel_orders order by created_at`.execute(db);
      const attempts = await sql<AttemptRow>`select * from content.reel_attempts order by order_id, take`.execute(db);
      return orders.rows.map((row) => ({
        order: orderOf(row),
        attempts: attempts.rows.filter((attempt) => attempt.order_id === row.id).map(attemptOf),
      }));
    },
  };
}
