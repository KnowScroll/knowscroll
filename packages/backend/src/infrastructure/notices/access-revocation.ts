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
 * goes out at once. Disposable like every hint: every subscribe also rechecks access, and relayed
 * hints are re-authorised (≤ 30 s cache), so a lost notice delays revocation, never skips it.
 */
export async function revokeAccountSockets(db: Kysely<Database>, accountId: string): Promise<void> {
  const notice = AccessRevokedNoticeSchema.parse({ v: 1, accountId });
  await sql`select pg_notify(${ACCESS_REVOKED_CHANNEL}, ${JSON.stringify(notice)})`.execute(db);
}
