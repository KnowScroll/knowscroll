import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './database.js';
import { ScopeClosedError, withTransaction } from './personal-scope.js';

// A fourth, disjoint capability. B, accounting, preparation and personal objects never enter here.
const live = new WeakMap<object, Transaction<Database>>();
interface Authority {
  readonly worldId: 'dev' | 'stage';
  readonly generation: number;
}
/** Generic only to avoid importing an owning module into infrastructure. Runtime proof is this map. */
export function makeWithCutroomReceiveScope<S extends object>(
  db: Kysely<Database>,
  options: { readonly enabled?: boolean; readonly lockTimeoutMs: number },
) {
  const enabled = options.enabled === true;
  return async <T>(
    input: Authority,
    mode: 'admit' | 'recover',
    work: (scope: S) => Promise<T>,
  ): Promise<
    | { readonly kind: 'entered'; readonly value: T }
    | { readonly kind: 'refused'; readonly code: 'disabled' | 'generation' }
  > => {
    const authority = Object.freeze({ worldId: input.worldId, generation: input.generation });
    if (
      !enabled ||
      !['dev', 'stage'].includes(authority.worldId) ||
      !Number.isSafeInteger(authority.generation) ||
      authority.generation < 1 ||
      !['admit', 'recover'].includes(mode)
    )
      return { kind: 'refused', code: 'disabled' };
    return withTransaction(db, 'cutroom-receive', async (trx) => {
      await sql`select set_config('lock_timeout',${`${options.lockTimeoutMs}ms`},true)`.execute(trx);
      await sql`set local statement_timeout='5s'`.execute(trx);
      // Read current authority AFTER the potentially waiting lock statement.
      const locked =
        await sql`select world_id from content.cutroom_receiving_state where world_id=${authority.worldId} for no key update`.execute(
          trx,
        );
      if (!locked.rows.length) return { kind: 'refused', code: 'disabled' };
      const root = (
        await sql<{
          enabled: boolean;
          generation: number;
        }>`select enabled,generation from content.cutroom_receiving_state where world_id=${authority.worldId}`.execute(
          trx,
        )
      ).rows[0];
      if (!root || (mode === 'admit' && !root.enabled)) return { kind: 'refused', code: 'disabled' };
      if (root.generation !== authority.generation) return { kind: 'refused', code: 'generation' };
      const scope = Object.freeze({ authority, mode, enabled: root.enabled }) as unknown as S;
      live.set(scope, trx);
      try {
        return { kind: 'entered', value: await work(scope) };
      } finally {
        live.delete(scope);
      }
    });
  };
}
export function cutroomReceiveTransactionOf(scope: object): Transaction<Database> {
  const trx = live.get(scope);
  if (!trx) throw new ScopeClosedError('Receive scope is forged or closed');
  return trx;
}
