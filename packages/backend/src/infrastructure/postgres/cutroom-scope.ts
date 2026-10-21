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
