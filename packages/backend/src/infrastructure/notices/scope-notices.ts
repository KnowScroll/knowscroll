import { sql } from 'kysely';
import { z } from 'zod';
import type { PersonalScopeTx } from '../../modules/identity/public.js';
import { transactionOf } from '../postgres/personal-scope.js';

/** The PostgreSQL channel of scope-change hints. */
export const SCOPE_NOTICE_CHANNEL = 'ks_scope_changed';

/**
 * A scope-change hint: which scope changed, its new revision, and the event that changed it. It
 * carries no private content and grants nothing; subscribers refetch through authorised HTTP
 * reads (blueprint §4 "Socket.IO and durable conversation delivery").
 */
export const ScopeNoticeSchema = z.object({
  v: z.literal(1),
  scope: z.object({ kind: z.literal('universe'), id: z.uuid() }),
  revision: z.number().int().min(0),
  eventId: z.uuid(),
});

export type ScopeNotice = z.infer<typeof ScopeNoticeSchema>;

/**
 * Queues a `pg_notify` inside the scope's transaction. PostgreSQL delivers it only if and after
 * the transaction commits; a rollback drops it. Disposable: a missed hint is recovered by the
 * client's revision catch-up, never by redelivery.
 */
export async function notifyScopeChanged(
  scope: PersonalScopeTx,
  change: { readonly revision: number; readonly eventId: string },
): Promise<void> {
  const notice: ScopeNotice = {
    v: 1,
    scope: { kind: 'universe', id: scope.authority.universeId },
    revision: change.revision,
    eventId: change.eventId,
  };
  await sql`select pg_notify(${SCOPE_NOTICE_CHANNEL}, ${JSON.stringify(ScopeNoticeSchema.parse(notice))})`.execute(
    transactionOf(scope),
  );
}
