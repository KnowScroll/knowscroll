import type pg from 'pg';
import { z } from 'zod';
import { assertOutsideTransaction } from '../../infrastructure/postgres/transaction-marker.js';
import { consumeCutroomNotSent } from '../application/cutroom.js';
import type {
  CutroomPool,
  CutroomPoolIdentity,
  CutroomPoolObservation,
  CutroomPoolReceipt,
} from '../application/cutroom-ports.js';
const tuple = 'row($2,$3,$4,$5,$6,$7,$8,$9)::public.pool_v2_identity';
const args = (i: CutroomPoolIdentity) => [
  i.grantRef,
  i.requestId,
  i.scriptSha256,
  i.take,
  i.until,
  i.requestSha256,
  i.worldId,
  i.ceilingCents,
  i.approvalRef,
];
const denied = (
  reason: 'pool_refused' | 'identity' | 'accounting_hold' | 'unknown' | 'needs_operator',
): CutroomPoolObservation => ({ kind: 'held', reason });
function bigint(value: unknown): bigint {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error('CUTROOM_POOL_INTEGER_INVALID');
}
const orderSchema = z.object({
  request_id: z.string(),
  script_digest: z.string(),
  take: z.number().int(),
  until: z.literal('video'),
  body_sha256: z.string(),
  ordered_by: z.enum(['dev', 'stage']),
  ceiling_cents: z.number().int(),
  approval_ref: z.string(),
  state: z.enum(['claimed', 'released', 'settled']),
  claimed_at: z.string(),
});
// PostgreSQL receipts retain all six fractional digits; JS Date would erase the last three.
const time = (v: unknown) =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
    .parse(v);
/** All connections, identity reads and mutations are outside the marked world transaction.
 * Dedicated session login/OID/world and complete immutable tuple are checked; no legacy helpers.
 * Routine pool0003 has NO release privilege. This adapter installs no role or ACL.
 */
export function makeCutroomPool(connect: () => Promise<pg.PoolClient>): CutroomPool {
  async function transact(
    i: CutroomPoolIdentity,
    mutate: boolean,
    run: (client: pg.PoolClient) => Promise<CutroomPoolObservation>,
  ): Promise<CutroomPoolObservation> {
    assertOutsideTransaction('cutroom-pool');
    const client = await connect();
    try {
      await client.query(mutate ? 'begin' : 'begin isolation level repeatable read read only');
      await client.query("set local statement_timeout='10s'; set local lock_timeout='5s'");
      const who = await client.query<{ name: string; oid: string; same: boolean }>(
        'select session_user as name,(select oid::text from pg_catalog.pg_roles where rolname=session_user) as oid,current_user=session_user as same',
      );
      const principal = who.rows[0];
      if (!principal || !principal.same || principal.name !== i.principalName || principal.oid !== i.principalOid) {
        await client.query('rollback');
        return denied('identity');
      }
      const result = await run(client);
      // A lost COMMIT acknowledgement throws; callers retain their committed SAME operation.
      await client.query('commit');
      return result;
    } catch {
      await client.query('rollback').catch(() => undefined);
      return denied(mutate ? 'needs_operator' : 'unknown');
    } finally {
      client.release();
    }
  }
  async function exact(
    client: pg.PoolClient,
    i: CutroomPoolIdentity,
    allowDisabled = false,
  ): Promise<CutroomPoolObservation> {
    const status = (
      await client.query<Record<string, unknown>>('select * from public.pool_v2_grant_status($1)', [i.grantRef])
    ).rows[0];
    if (!status) return denied('pool_refused');
    for (const key of [
      'cap_cents',
      'base_cents',
      'effective_cents',
      'grant_cap_cents',
      'grant_base_cents',
      'grant_effective_cents',
      'pending_count',
    ])
      bigint(status[key]);
    if (
      status['accounting_hold'] !== false ||
      bigint(status['pending_count']) !== 0n ||
      !Array.isArray(status['pending_evidence']) ||
      status['pending_evidence'].length !== 0
    )
      return denied('accounting_hold');
    if (!allowDisabled && (status['enabled'] !== true || status['retired'] !== false)) return denied('pool_refused');
    const result = await client.query<{
      order_row: unknown;
      binding_id: unknown;
      claimed_at: unknown;
      bound_at: unknown;
      pending_evidence: unknown;
    }>(
      `select to_jsonb(r.order_row) as order_row,r.binding_id,
        to_char((r.order_row).claimed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as claimed_at,
        to_char(r.bound_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as bound_at,
        r.pending_evidence from public.pool_v2_read_order($1,${tuple}) r`,
      args(i),
    );
    if (result.rows.length !== 1) return denied('identity');
    const r = result.rows[0]!,
      parsed = orderSchema.safeParse(r.order_row);
    if (!parsed.success) return denied('identity');
    const o = parsed.data;
    if (
      JSON.stringify([
        o.request_id,
        o.script_digest,
        o.take,
        o.until,
        o.body_sha256,
        o.ordered_by,
        o.ceiling_cents,
        o.approval_ref,
      ]) !== JSON.stringify(args(i).slice(1)) ||
      !z.uuid().safeParse(r.binding_id).success
    )
      return denied('identity');
    if (!Array.isArray(r.pending_evidence) || r.pending_evidence.length !== 0) return denied('accounting_hold');
    if (o.state === 'settled') return denied('needs_operator');
    const receipt: CutroomPoolReceipt = {
      bindingId: r.binding_id as string,
      claimedAt: time(r.claimed_at),
      boundAt: time(r.bound_at),
    };
    return { kind: 'exact', state: o.state, receipt };
  }
  return {
    claim: (i) =>
      transact(i, true, async (client) => {
        const result = await client.query<{ status: string }>(
          `select status from public.pool_v2_claim($1,${tuple})`,
          args(i),
        );
        if (!['claimed', 'already_claimed'].includes(result.rows[0]?.status ?? '')) return denied('pool_refused');
        return exact(client, i);
      }),
    read: (i) => transact(i, false, (client) => exact(client, i)),
    async release(i, operation, proof) {
      assertOutsideTransaction('cutroom-pool-release');
      const expected = consumeCutroomNotSent(proof, operation, i);
      if (!expected) return denied('identity');
      return transact(i, true, async (client) => {
        const before = await exact(client, i, true);
        if (before.kind !== 'exact' || JSON.stringify(before.receipt) !== JSON.stringify(expected))
          return denied('identity');
        const result = await client.query<{ result: string }>(
          `select public.pool_v2_release_not_sent($1,${tuple}) as result`,
          args(i),
        );
        if (!['released', 'already_released'].includes(result.rows[0]?.result ?? '')) return denied('needs_operator');
        const after = await exact(client, i, true);
        return after.kind === 'exact' &&
          after.state === 'released' &&
          JSON.stringify(after.receipt) === JSON.stringify(expected)
          ? after
          : denied('identity');
      });
    },
  };
}
