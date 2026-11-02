import { sql } from 'kysely';
import { PublicPersonRefSchema } from '@knowscroll/contracts';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type {
  PublicPerson,
  ReadBlockedAmong,
  ReadFriendAccounts,
  ReadPublicPeople,
  ReadReportableMessage,
} from '../public.js';

interface PersonColumns {
  account_id: string;
  person_id: string;
  handle: string;
  display_name: string;
}

const personOf = (row: PersonColumns): PublicPerson => ({
  accountId: row.account_id,
  person: PublicPersonRefSchema.parse({
    kind: 'person',
    personId: row.person_id,
    handle: row.handle,
    displayName: row.display_name,
  }),
});

/** Claimed profiles of active accounts, by account ID or by public person ID. A person with no claimed profile is absent. */
export const readPublicPeople: ReadPublicPeople = async (scope, query) => {
  const wanted =
    'accountIds' in query
      ? sql`profile.account_id = any(${[...query.accountIds]}::uuid[])`
      : sql`profile.person_id = any(${[...query.personIds]}::uuid[])`;
  if (('accountIds' in query ? query.accountIds : query.personIds).length === 0) return [];
  const rows = await sql<PersonColumns>`
    select profile.account_id, profile.person_id, profile.handle, profile.display_name
    from social.profiles profile
    join identity.accounts account on account.id = profile.account_id and account.status = 'active'
    where ${wanted}`.execute(transactionOf(scope));
  return rows.rows.map(personOf);
};

/**
 * The caller's current friends: an accepted friendship that neither side has removed or blocked (the
 * pair keeps no accepted lineage otherwise) and an active account on the other side: at most
 * `limit` of them in a fixed order, or the one friend with that public person ID.
 */
export const readFriendAccounts: ReadFriendAccounts = async (scope, accountId, query) => {
  const one = 'personId' in query ? sql`and profile.person_id = ${query.personId}::uuid` : sql``;
  const limit = 'limit' in query ? sql`limit ${query.limit}` : sql`limit 1`;
  const rows = await sql<PersonColumns>`
    select profile.account_id, profile.person_id, profile.handle, profile.display_name
    from social.pairs pair
    join social.profiles profile on profile.account_id =
      case when pair.low_account_id = ${accountId}::uuid then pair.high_account_id else pair.low_account_id end
    join identity.accounts account on account.id = profile.account_id and account.status = 'active'
    where (pair.low_account_id = ${accountId}::uuid or pair.high_account_id = ${accountId}::uuid)
      and pair.accepted_lineage is not null ${one}
    order by profile.person_id ${limit}`.execute(transactionOf(scope));
  return rows.rows.map(personOf);
};

/** Which of these accounts the caller has blocked: their own side of a pair says so, the other side never does. */
export const readBlockedAmong: ReadBlockedAmong = async (scope, accountId, candidates) => {
  if (candidates.length === 0) return new Set();
  const rows = await sql<{ other: string }>`
    select case when pair.low_account_id = ${accountId}::uuid then pair.high_account_id else pair.low_account_id end as other
    from social.pairs pair
    join social.pair_sides side on side.pair_id = pair.pair_id and side.account_id = ${accountId}::uuid
    where side.own_blocked
      and ((pair.low_account_id = ${accountId}::uuid and pair.high_account_id = any(${[...candidates]}::uuid[]))
        or (pair.high_account_id = ${accountId}::uuid and pair.low_account_id = any(${[...candidates]}::uuid[])))`.execute(
    transactionOf(scope),
  );
  return new Set(rows.rows.map((row) => row.other));
};

/**
 * A message of a conversation or content thread that the caller still takes part in (a member who has
 * not left and has joined, not merely been invited). The friendship need not stand: a person who
 * blocked someone keeps what that person sent them and can report it.
 */
export const readReportableMessage: ReadReportableMessage = async (scope, accountId, messageId) => {
  const rows = await sql<{ author_account_id: string }>`
    select message.author_account_id
    from social.messages message
    join social.conversation_members member
      on member.conversation_id = message.conversation_id and member.account_id = ${accountId}::uuid
    where message.message_id = ${messageId}::uuid and message.author_account_id is not null
      and member.left_at is null and not member.pending`.execute(transactionOf(scope));
  const row = rows.rows[0];
  return row === undefined ? undefined : { authorAccountId: row.author_account_id };
};
