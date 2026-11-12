import { sql } from 'kysely';
import type { PersonalScopeTx } from '../../modules/identity/public.js';
import { transactionOf } from './personal-scope.js';

/** What a best-effort step came to: it worked, or it failed with a code (a PostgreSQL error code or `error`) and left no trace. */
export type BestEffort = { readonly ok: true } | { readonly ok: false; readonly code: string };

/** The longest a best-effort step may wait for a lock, in milliseconds: it gives up rather than make the caller wait. */
export const BEST_EFFORT_LOCK_WAIT_MS = 100;

/** A code safe to log: the PostgreSQL error code when there is one, else `error`. */
const codeOf = (error: unknown): string => {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Za-z_]{1,16}$/u.test(code) ? code.toLowerCase() : 'error';
};

/**
 * Runs a side effect inside an open personal transaction that must never be able to fail or delay that transaction (#674, D-414: a count for
 * the gap loop recorded while a person navigates). The effect runs under a savepoint: if it fails, its writes are rolled back to the savepoint,
 * the error is swallowed and the code is returned, and the transaction goes on as if it had not been tried. While it runs the lock timeout is
 * short ({@link BEST_EFFORT_LOCK_WAIT_MS}), so a row another transaction holds makes it fail at once instead of making the caller wait; the caller's
 * own timeout is restored after. It adds no network wait. A connection that has died is not a failure to swallow: the transaction is lost
 * anyway, so the error of the rollback propagates.
 */
export async function bestEffort(scope: PersonalScopeTx, effect: () => Promise<void>): Promise<BestEffort> {
  const trx = transactionOf(scope);
  const { rows } = await sql<{ timeout: string }>`select current_setting('lock_timeout') as timeout`.execute(trx);
  const previous = rows[0]?.timeout ?? '0';
  await sql`savepoint best_effort`.execute(trx);
  try {
    await sql`select set_config('lock_timeout', ${`${String(BEST_EFFORT_LOCK_WAIT_MS)}ms`}, true)`.execute(trx);
    await effect();
    await sql`release savepoint best_effort`.execute(trx);
    return { ok: true };
  } catch (error) {
    await sql`rollback to savepoint best_effort`.execute(trx);
    await sql`release savepoint best_effort`.execute(trx);
    return { ok: false, code: codeOf(error) };
  } finally {
    await sql`select set_config('lock_timeout', ${previous}, true)`.execute(trx);
  }
}
