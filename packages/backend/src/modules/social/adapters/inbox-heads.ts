import type { Transaction } from 'kysely';
import { notifyInboxChanged } from '../../../infrastructure/notices/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { InboxChange } from '../application/conversation-ports.js';

/**
 * Bumps each account's inbox revision and queues its live hint, in canonical account order so two
 * transactions touching the same accounts can never take the heads crosswise. The hint is
 * delivered after commit and dropped on rollback; it carries the person's own universe ID and
 * the new revision, nothing else.
 */
export async function bumpInboxHeads(
  trx: Transaction<Database>,
  changes: readonly InboxChange[],
  newEventId: () => string,
): Promise<void> {
  for (const change of [...changes].sort((a, b) => (a.accountId < b.accountId ? -1 : 1))) {
    const head = await trx
      .insertInto('social.inbox_heads')
      .values({ account_id: change.accountId, revision: 1 })
      .onConflict((conflict) =>
        conflict.column('account_id').doUpdateSet((eb) => ({ revision: eb('social.inbox_heads.revision', '+', 1) })),
      )
      .returning('revision')
      .executeTakeFirstOrThrow();
    await notifyInboxChanged(trx, {
      universeId: change.universeId,
      revision: Number(head.revision),
      eventId: newEventId(),
    });
  }
}
