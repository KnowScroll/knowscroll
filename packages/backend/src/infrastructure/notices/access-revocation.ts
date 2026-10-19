import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../postgres/database.js';

/** The PostgreSQL channel of access-revocation notices. */
export const ACCESS_REVOKED_CHANNEL = 'ks_access_revoked';

/** An account whose existing live subscriptions must be dropped. Carries the account ID only. */
export const AccessRevokedNoticeSchema = z.object({ v: z.literal(1), accountId: z.uuid() });

/**
 * Drops every live socket of `accountId` in every API process: sends a `pg_notify` on
 * `ks_access_revoked`, which each API's relay hands to its gateway. Call it inside the
 * transaction that revokes access (sign-out, session revocation, privacy epoch change; S1.3
 * identity), so the notice goes out only if the revocation commits; outside a transaction it
 * goes out at once.
 *
 * The notice itself is disposable: an API whose relay is reconnecting at that moment never sees
 * it. Revocation therefore does not rest on the notice alone:
 * - when a relay reconnects, its gateway forgets every cached authorisation and closes every
 *   socket, so each client authenticates again (which validates its session) before it gets
 *   another hint;
 * - every subscribe, and every relayed hint (cache ≤ `KS_SOCKET_AUTH_CACHE_MS`, at most 30 s),
 *   rechecks the caller's session validity and its access to the scope.
 * With the S1.3 session store, a revoked session is therefore refused at the latest on the next
 * reconnect, subscribe or (after the cache) relayed hint, even if this notice was lost.
 */
export async function revokeAccountSockets(db: Kysely<Database>, accountId: string): Promise<void> {
  const notice = AccessRevokedNoticeSchema.parse({ v: 1, accountId });
  await sql`select pg_notify(${ACCESS_REVOKED_CHANNEL}, ${JSON.stringify(notice)})`.execute(db);
}
