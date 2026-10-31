import { sql, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/postgres/database.js';

/**
 * Lets go of the people one account invited, when that account leaves a thread (`threadId` given) or
 * leaves the product (all its threads). An invitee whose friendship with the inviter still stands keeps
 * their place and from now on stands on their own membership. An invitee whose friendship already
 * ended (Remove, Block, a new friendship) had lost their place; it is closed here, because dropping
 * the link would otherwise give it back, and their party place goes with it (D-065). Call it before the
 * inviter's friendships are deleted. Returns how many member rows changed.
 */
export async function releaseInvitees(
  trx: Transaction<Database>,
  inviterAccountId: string,
  now: Date,
  threadId?: string,
): Promise<number> {
  const inThread = threadId === undefined ? sql`` : sql`and member.conversation_id = ${threadId}::uuid`;
  await sql`
    delete from social.thread_places place using social.conversation_members member
    where member.conversation_id = place.thread_id and member.account_id = place.account_id
      and member.invited_by_account_id = ${inviterAccountId}::uuid ${inThread}
      and not exists (
        select 1 from social.pairs pair
        where pair.low_account_id = least(member.account_id, member.invited_by_account_id)
          and pair.high_account_id = greatest(member.account_id, member.invited_by_account_id)
          and pair.accepted_lineage = member.invited_lineage
      )`.execute(trx);
  const released = await sql`
    update social.conversation_members member
    set invited_by_account_id = null, invited_lineage = null,
      left_at = coalesce(member.left_at, case when exists (
        select 1 from social.pairs pair
        where pair.low_account_id = least(member.account_id, member.invited_by_account_id)
          and pair.high_account_id = greatest(member.account_id, member.invited_by_account_id)
          and pair.accepted_lineage = member.invited_lineage
      ) then null else ${now}::timestamptz end)
    where member.invited_by_account_id = ${inviterAccountId}::uuid ${inThread}`.execute(trx);
  return Number(released.numAffectedRows ?? 0);
}
