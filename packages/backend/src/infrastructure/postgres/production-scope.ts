import { sql, type Kysely, type Transaction } from 'kysely';
import type { ProductionAuthority, ProductionScopeTx, WithProductionScope } from '../../reasoning/public.js';
import type { Database } from './database.js';
import { ScopeClosedError, withTransaction } from './personal-scope.js';

const openScopes = new WeakMap<ProductionScopeTx, Transaction<Database>>();

/**
 * Production's shared-only protocol (blueprint §19): root first, never a personal root later.
 * Configuration and the database kill switch must both be enabled. Authority is frozen before
 * waiting, and generation/enabled are rechecked after FOR NO KEY UPDATE. No network spans it.
 */
export function makeWithProductionScope(
  db: Kysely<Database>,
  options: { readonly enabled: boolean; readonly lockTimeoutMs: number },
): WithProductionScope {
  return async (claimed, work) => {
    const authority = Object.freeze({ scopeId: claimed.scopeId, generation: claimed.generation });
    if (!options.enabled || !validAuthority(authority)) return disabled();
    return withTransaction(db, 'production-scope', async (trx) => {
      await sql`select set_config('lock_timeout', ${`${options.lockTimeoutMs}ms`}, true)`.execute(trx);
      const root = await trx
        .selectFrom('reasoning.production_scopes')
        .select(['enabled', 'generation'])
        .where('id', '=', authority.scopeId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (root === undefined || !root.enabled) return disabled();
      if (root.generation !== authority.generation)
        return { kind: 'refused', refusal: { kind: 'generation_changed' } } as const;
      const scope = Object.freeze({ authority }) as unknown as ProductionScopeTx;
      openScopes.set(scope, trx);
      try {
        return { kind: 'entered', value: await work(scope) } as const;
      } finally {
        openScopes.delete(scope);
      }
    });
  };
}

function disabled() {
  return { kind: 'refused', refusal: { kind: 'production_disabled' } } as const;
}

function validAuthority(authority: ProductionAuthority): boolean {
  return authority.scopeId === 'scroll-supply' && Number.isInteger(authority.generation) && authority.generation > 0;
}

/** Lock-free output eligibility, repeated under the root lock by the result applier. */
export function makeProductionAuthorityHolds(db: Kysely<Database>, enabled: boolean) {
  return async (authority: ProductionAuthority): Promise<boolean> => {
    if (!enabled || !validAuthority(authority)) return false;
    const row = await db
      .selectFrom('reasoning.production_scopes')
      .select(['enabled', 'generation'])
      .where('id', '=', authority.scopeId)
      .executeTakeFirst();
    return row?.enabled === true && row.generation === authority.generation;
  };
}

/** Adapter access to the transaction behind an open capability; unusable after callback/rollback. */
export function productionTransactionOf(scope: ProductionScopeTx): Transaction<Database> {
  const trx = openScopes.get(scope);
  if (trx === undefined) throw new ScopeClosedError('Production scope used after its transaction ended');
  return trx;
}
