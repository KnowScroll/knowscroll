import { sql } from 'kysely';
import type { SharedRootLock } from '@knowscroll/backend/infrastructure/postgres';

/**
 * CI fixture shared root: no shared-scope tables exist yet (conversations arrive in Phase 3), so
 * the lock is a transaction-scoped advisory lock on the root's identity — a real lock with the
 * same ordering behaviour as a row lock.
 */
export function advisoryRoot(kind: string, id: string): SharedRootLock {
  return {
    kind,
    id,
    async lock(trx) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${kind}:${id}`}, 0))`.execute(trx);
      return true;
    },
  };
}
