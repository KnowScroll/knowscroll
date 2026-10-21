import { sql, type Kysely, type Transaction } from 'kysely';
import type { CutroomScopeTx, WithCutroomScope } from '../../reasoning/public.js';
import { ScopeClosedError, withTransaction } from './personal-scope.js';
import type { Database } from './database.js';
const live = new WeakMap<CutroomScopeTx, Transaction<Database>>();
/** Root first; no root is seeded. Recovery cannot admit a new claim under a disabled root. */
export function makeWithCutroomScope(
  db: Kysely<Database>,
  options: { readonly enabled: boolean; readonly lockTimeoutMs: number },
): WithCutroomScope {
  const enabled = options.enabled;
  return async (claimed, mode, work) => {
    const authority = Object.freeze({ worldId: claimed.worldId, generation: claimed.generation });
    if (
      !enabled ||
      !['dev', 'stage'].includes(authority.worldId) ||
      !Number.isSafeInteger(authority.generation) ||
      authority.generation < 1
    )
      return { kind: 'refused', code: 'disabled' };
    return withTransaction(db, 'cutroom-scope', async (trx) => {
      await sql`select set_config('lock_timeout', ${`${options.lockTimeoutMs}ms`}, true)`.execute(trx);
      const root = await trx
        .selectFrom('reasoning.cutroom_scopes')
        .select(['enabled', 'generation'])
        .where('world_id', '=', authority.worldId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!root || (mode === 'admit' && !root.enabled)) return { kind: 'refused', code: 'disabled' } as const;
      if (root.generation !== authority.generation) return { kind: 'refused', code: 'generation' } as const;
      const scope = Object.freeze({ authority, mode, enabled: root.enabled }) as unknown as CutroomScopeTx;
      live.set(scope, trx);
      try {
        return { kind: 'entered', value: await work(scope) } as const;
      } finally {
        live.delete(scope);
      }
    });
  };
}
export function cutroomTransactionOf(scope: CutroomScopeTx): Transaction<Database> {
  const trx = live.get(scope);
  if (!trx) throw new ScopeClosedError('Cutroom scope is forged or closed');
  return trx;
}

// Separate live map: accounting scopes can NEVER be used by B's request/claim/dispatch adapters.
import type {
  CutroomAccountingScopeTx,
  WithCutroomAccountingScope,
  CutroomPoolIdentity,
} from '../../reasoning/public.js';
import { z } from 'zod';
const accountingLive = new WeakMap<CutroomAccountingScopeTx, Transaction<Database>>();
const accountingTarget = z.strictObject({
  worldId: z.enum(['dev', 'stage']),
  businessRunId: z.uuid(),
  attemptId: z.uuid(),
});
/** Current root -> exact Content business -> retained attempt. Disabled/old-generation liability survives. */
export function makeWithCutroomAccountingScope(
  db: Kysely<Database>,
  options: { readonly enabled: boolean; readonly lockTimeoutMs: number },
): WithCutroomAccountingScope {
  const enabled = options.enabled;
  return async (input, work) => {
    const target = accountingTarget.safeParse(input);
    if (!enabled) return { kind: 'refused', code: 'disabled' };
    if (!target.success) return { kind: 'refused', code: 'identity' };
    const t = target.data;
    return withTransaction(db, 'cutroom-accounting', async (trx) => {
      await sql`select set_config('lock_timeout',${`${options.lockTimeoutMs}ms`},true)`.execute(trx);
      const root = await trx
        .selectFrom('reasoning.cutroom_scopes')
        .select('generation')
        .where('world_id', '=', t.worldId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!root) return { kind: 'refused', code: 'identity' } as const;
      const c = await trx
        .selectFrom('content.reel_commissions')
        .selectAll()
        .where('world_id', '=', t.worldId)
        .where('business_run_id', '=', t.businessRunId)
        .forUpdate()
        .executeTakeFirst();
      if (!c || c.attempt_id !== t.attemptId) return { kind: 'refused', code: 'identity' } as const;
      const a = await trx
        .selectFrom('reasoning.cutroom_attempts')
        .selectAll()
        .where('id', '=', t.attemptId)
        .where('world_id', '=', t.worldId)
        .where('business_run_id', '=', t.businessRunId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !a ||
        a.generation !== c.generation ||
        a.script_sha256 !== c.script_sha256 ||
        a.evidence_sha256 !== c.evidence_sha256 ||
        a.request_sha256 !== c.request_sha256 ||
        a.request_id !== c.request_id ||
        a.take !== c.take ||
        a.ceiling_cents !== c.ceiling_cents ||
        a.approval_ref !== c.approval_ref ||
        a.policy_version !== c.policy_version
      )
        return { kind: 'refused', code: 'identity' } as const;
      const identity: CutroomPoolIdentity = Object.freeze({
        worldId: t.worldId,
        grantRef: 'knowscroll-v2-d018',
        requestId: a.request_id,
        scriptSha256: a.script_sha256,
        take: a.take,
        until: 'video',
        requestSha256: a.request_sha256,
        ceilingCents: a.ceiling_cents,
        approvalRef: a.approval_ref,
        principalOid: a.principal_oid,
        principalName: a.principal_name,
      });
      const scope = Object.freeze({
        ...t,
        currentGeneration: root.generation,
        attemptGeneration: a.generation,
        fence: a.fence,
        identity,
      }) as CutroomAccountingScopeTx;
      accountingLive.set(scope, trx);
      try {
        return { kind: 'entered', value: await work(scope) } as const;
      } finally {
        accountingLive.delete(scope);
      }
    });
  };
}
export function cutroomAccountingTransactionOf(scope: CutroomAccountingScopeTx): Transaction<Database> {
  const trx = accountingLive.get(scope);
  if (!trx) throw new ScopeClosedError('Cutroom accounting scope is forged or closed');
  return trx;
}
