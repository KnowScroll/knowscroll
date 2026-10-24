import type { Kysely } from 'kysely';
import { uuidv7 } from '../../../infrastructure/ids/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { readerOn, sharedTransactionOf, withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import type { ThreadGuestPorts } from '../application/thread-guest.js';
import { canTakePart } from '../domain/threads.js';
import type { AnnounceThread, ReadThreadStanding } from '../public.js';
import { bumpInboxHeads } from './inbox-heads.js';
import { memberOf, selectMembers } from './postgres-threads.js';

/** Where a message of the locked thread sits in its sequence; none for a message of another conversation. */
export const sequenceOf: ThreadGuestPorts['sequenceOf'] = async (lock, messageId) => {
  const row = await sharedTransactionOf(lock.shared)
    .selectFrom('social.messages')
    .select('sequence')
    .where('conversation_id', '=', lock.threadId)
    .where('message_id', '=', messageId)
    .executeTakeFirst();
  return row === undefined ? undefined : Number(row.sequence);
};

/**
 * Whether the account takes part in the thread right now: joined, not left, account active and, for
 * an invited member, the friendship that carried the invitation standing. One read with no lock, for
 * deciding who may read something that belongs to the thread; whatever acts on the answer rechecks.
 */
export function makeReadThreadStanding(db: Kysely<Database>): ReadThreadStanding {
  return async (on, accountId, threadId) => {
    const members = (await selectMembers(readerOn(db, on), [threadId])).rows.map(memberOf);
    const member = members.find((candidate) => candidate.accountId === accountId);
    return member !== undefined && canTakePart(member);
  };
}

/**
 * Tells every participant's inbox that a thread changed, in its own short transaction after the
 * change committed. The hint is disposable: the screens also poll, so a crash between the commit and
 * this call delays an update and loses nothing.
 */
export function makeAnnounceThread(db: Kysely<Database>): AnnounceThread {
  return (threadId) =>
    withTransaction(db, 'social.announce-thread', async (trx) => {
      const members = (await selectMembers(trx, [threadId])).rows.map(memberOf);
      const changes = members
        .filter(canTakePart)
        .map((member) => ({ accountId: member.accountId, universeId: member.universeId }));
      await bumpInboxHeads(trx, changes, uuidv7);
    });
}
