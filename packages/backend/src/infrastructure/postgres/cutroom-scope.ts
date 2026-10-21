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
        .select([
          'attempt_id',
          'generation',
          'script_sha256',
          'evidence_sha256',
          'request_sha256',
          'take',
          'ceiling_cents',
          'approval_ref',
          'policy_version',
          sql<string | null>`case when octet_length(request_id) <= 128 then request_id else null end`.as('request_id'),
        ])
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

// A third disjoint live map. Read-only preparation cannot obtain either mutable capability.
import type { CutroomPreparationScopeTx, WithCutroomPreparationScope } from '../../reasoning/public.js';
const preparationLive = new WeakMap<CutroomPreparationScopeTx, Transaction<Database>>();
const preparationAuthority = z.strictObject({
  worldId: z.enum(['dev', 'stage']),
  generation: z.number().int().min(1).max(2147483647),
});
/** Default disabled; no root seed, row locks, request bytes, jobs or external work. */
export function makeWithCutroomPreparationScope(
  db: Kysely<Database>,
  options: { readonly enabled?: boolean } = {},
): WithCutroomPreparationScope {
  const enabled = options.enabled ?? false;
  return async (claimed, work) => {
    if (!enabled) return { kind: 'refused', code: 'disabled' };
    const parsed = preparationAuthority.safeParse(claimed);
    if (!parsed.success) return { kind: 'refused', code: 'identity' };
    const authority = Object.freeze(parsed.data);
    return withTransaction(db, 'cutroom-preparation', async (trx) => {
      // First statement after BEGIN: establish the actual server-enforced snapshot before reads.
      await sql`set transaction isolation level repeatable read, read only`.execute(trx);
      await sql`set local statement_timeout = '5000ms'`.execute(trx);
      await sql`set local lock_timeout = '5000ms'`.execute(trx);
      const root = await trx
        .selectFrom('reasoning.cutroom_scopes')
        .select(['enabled', 'generation'])
        .where('world_id', '=', authority.worldId)
        .executeTakeFirst();
      if (!root) return { kind: 'refused', code: 'identity' } as const;
      if (root.generation !== authority.generation) return { kind: 'refused', code: 'generation' } as const;
      const scope = Object.freeze({ authority, rootEnabledAtSnapshot: root.enabled }) as CutroomPreparationScopeTx;
      preparationLive.set(scope, trx);
      try {
        return { kind: 'entered', value: await work(scope) } as const;
      } finally {
        preparationLive.delete(scope);
      }
    });
  };
}
/** Only metadata adapters use this getter. PG itself refuses all writes/locking reads. */
export function cutroomPreparationTransactionOf(scope: CutroomPreparationScopeTx): Transaction<Database> {
  const trx = preparationLive.get(scope);
  if (!trx) throw new ScopeClosedError('Cutroom preparation scope is forged or closed');
  return trx;
}
