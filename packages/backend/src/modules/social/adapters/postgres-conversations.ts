import { sql, type Transaction } from 'kysely';
import { PublicPersonRefSchema } from '@knowscroll/contracts';
import type { Database } from '../../../infrastructure/postgres/database.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { sharedTransactionOf, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { DELETED_PERSON } from '../application/deleted-person.js';
import { bumpInboxHeads } from './inbox-heads.js';
import type {
  ContentCard,
  ContentRef,
  Conversation,
  ConversationReader,
  ConversationRow,
  ConversationStore,
  InboxRow,
  MemberRow,
  MessageRow,
} from '../application/conversation-ports.js';
import type { PairLock } from '../application/ports.js';

type ReadContent = (scope: PersonalScopeTx, refs: readonly ContentRef[]) => Promise<readonly ContentCard[]>;

const trxOf = (reader: ConversationReader): Transaction<Database> =>
  'shared' in reader ? sharedTransactionOf(reader.shared) : transactionOf(reader);

const memberOf = (row: {
  account_id: string;
  membership_id: string;
  membership_revision: string;
  read_through_sequence: string;
  muted: boolean;
  left_at: unknown;
}): MemberRow => ({
  accountId: row.account_id,
  membershipId: row.membership_id,
  membershipRevision: Number(row.membership_revision),
  readThroughSequence: Number(row.read_through_sequence),
  muted: row.muted,
  left: row.left_at !== null,
});

const conversationOf = (row: {
  conversation_id: string;
  pair_id: string | null;
  lineage: string;
  last_sequence: string;
  last_change_sequence: string;
  last_activity_at: Date | string;
  closed_at: unknown;
}): ConversationRow => ({
  conversationId: row.conversation_id,
  pairId: row.pair_id,
  lineage: row.lineage,
  lastSequence: Number(row.last_sequence),
  lastChangeSequence: Number(row.last_change_sequence),
  lastActivityAt: new Date(row.last_activity_at),
  closed: row.closed_at !== null,
});

export interface MessageColumns {
  sequence: string;
  change_sequence: string;
  message_id: string;
  command_id: string | null;
  recorded_at: Date | string;
  body_text: string | null;
  asset_id: string | null;
  asset_revision: number | null;
  note: string | null;
  person_id: string | null;
  handle: string | null;
  display_name: string | null;
}

export const messageOf = (row: MessageColumns): MessageRow => ({
  sequence: Number(row.sequence),
  changeSequence: Number(row.change_sequence),
  messageId: row.message_id,
  commandId: row.command_id,
  recordedAt: new Date(row.recorded_at),
  author:
    row.person_id === null
      ? null
      : PublicPersonRefSchema.parse({
          kind: 'person',
          personId: row.person_id,
          handle: row.handle,
          displayName: row.display_name,
        }),
  text: row.body_text,
  content: row.asset_id === null ? null : { assetId: row.asset_id, assetRevision: row.asset_revision! },
  note: row.note,
});

export const MESSAGE_COLUMNS = [
  'm.sequence',
  'm.change_sequence',
  'm.message_id',
  'm.command_id',
  'm.recorded_at',
  'm.body_text',
  'm.asset_id',
  'm.asset_revision',
  'm.note',
  'p.person_id',
  'p.handle',
  'p.display_name',
] as const;

/** Postgres conversation rows (migration 0056). The use cases decide who may read or write; this only runs queries. */
export function conversationStore(readContent: ReadContent): ConversationStore {
  return {
    async ownMembership(scope, accountId, conversationId) {
      const rows = await transactionOf(scope)
        .selectFrom('social.conversation_members as m')
        .innerJoin('social.conversations as c', 'c.conversation_id', 'm.conversation_id')
        .leftJoin('social.conversation_members as pm', (join) =>
          join.onRef('pm.conversation_id', '=', 'm.conversation_id').onRef('pm.account_id', '<>', 'm.account_id'),
        )
        .select([
          'c.pair_id',
          'pm.account_id as peer_account_id',
          'm.account_id',
          'm.membership_id',
          'm.membership_revision',
          'm.read_through_sequence',
          'm.muted',
          'm.left_at',
        ])
        .where('m.conversation_id', '=', conversationId)
        .where('m.account_id', '=', accountId)
        .execute();
      const row = rows[0];
      return row && { pairId: row.pair_id, peerAccountId: row.peer_account_id ?? undefined, own: memberOf(row) };
    },

    async load(reader, conversationId, ownAccountId) {
      return loadConversation(reader, { conversationId, ownAccountId });
    },

    async findOpen(lock, lineage, ownAccountId) {
      return loadConversation(lock, { lineage, ownAccountId });
    },

    async create(lock, input) {
      const trx = trxOf(lock);
      await trx
        .insertInto('social.conversations')
        .values({
          conversation_id: input.conversationId,
          pair_id: lock.pair.id,
          lineage: input.lineage,
          last_activity_at: input.now,
          created_at: input.now,
        })
        .execute();
      await trx
        .insertInto('social.conversation_members')
        .values(
          input.members.map((member) => ({
            conversation_id: input.conversationId,
            account_id: member.accountId,
            membership_id: member.membershipId,
          })),
        )
        .execute();
    },

    async append(lock, conversationId, message) {
      const trx = trxOf(lock);
      const counters = await trx
        .updateTable('social.conversations')
        .set((eb) => ({
          last_sequence: sql`last_sequence + 1`,
          last_change_sequence: sql`last_change_sequence + 1`,
          last_activity_at: eb.fn('greatest', ['last_activity_at', eb.val(message.recordedAt)]),
        }))
        .where('conversation_id', '=', conversationId)
        .returning(['last_sequence', 'last_change_sequence'])
        .executeTakeFirstOrThrow();
      const sequence = Number(counters.last_sequence);
      const changeSequence = Number(counters.last_change_sequence);
      await trx
        .insertInto('social.messages')
        .values({
          conversation_id: conversationId,
          sequence,
          message_id: message.messageId,
          change_sequence: changeSequence,
          command_id: message.commandId,
          author_account_id: message.authorAccountId,
          recorded_at: message.recordedAt,
          body_text: message.text ?? null,
          asset_id: message.content?.assetId ?? null,
          asset_revision: message.content?.assetRevision ?? null,
          note: message.note ?? null,
        })
        .execute();
      return { sequence, changeSequence };
    },

    async messages(reader, conversationId, query) {
      let select = trxOf(reader)
        .selectFrom('social.messages as m')
        .leftJoin('social.profiles as p', 'p.account_id', 'm.author_account_id')
        .select([...MESSAGE_COLUMNS])
        .where('m.conversation_id', '=', conversationId);
      if (query.after !== undefined)
        select = select.where('m.change_sequence', '>', String(query.after)).orderBy('m.change_sequence', 'asc');
      else {
        if (query.before !== undefined) select = select.where('m.sequence', '<', String(query.before));
        select = select.orderBy('m.sequence', 'desc');
      }
      return (await select.limit(query.limit).execute()).map(messageOf);
    },

    async messageOfCommand(reader, conversationId, authorAccountId, commandId) {
      const row = await trxOf(reader)
        .selectFrom('social.messages as m')
        .leftJoin('social.profiles as p', 'p.account_id', 'm.author_account_id')
        .select([...MESSAGE_COLUMNS])
        .where('m.conversation_id', '=', conversationId)
        .where('m.author_account_id', '=', authorAccountId)
        .where('m.command_id', '=', commandId)
        .executeTakeFirst();
      return row && messageOf(row);
    },

    async setReadThrough(reader, conversationId, accountId, sequence) {
      await trxOf(reader)
        .updateTable('social.conversation_members')
        .set({ read_through_sequence: sequence })
        .where('conversation_id', '=', conversationId)
        .where('account_id', '=', accountId)
        .execute();
    },

    async setMuted(reader, conversationId, accountId, muted) {
      await trxOf(reader)
        .updateTable('social.conversation_members')
        .set({ muted })
        .where('conversation_id', '=', conversationId)
        .where('account_id', '=', accountId)
        .execute();
    },

    async leave(reader, conversationId, accountId, now) {
      const trx = trxOf(reader);
      await trx
        .updateTable('social.conversation_members')
        .set({ left_at: now })
        .where('conversation_id', '=', conversationId)
        .where('account_id', '=', accountId)
        .execute();
      await trx
        .updateTable('social.conversations')
        .set({ closed_at: now })
        .where('conversation_id', '=', conversationId)
        .execute();
    },

    async announce(reader, changes, newEventId) {
      await bumpInboxHeads(trxOf(reader), changes, newEventId);
    },

    async inbox(scope, accountId, query) {
      const trx = transactionOf(scope);
      const rows = await selectInboxRows(trx, accountId, query);
      const lastMessages = await selectLastMessages(trx, rows);
      return rows.map((row) => inboxRowOf(row, lastMessages.get(row.conversation_id)));
    },

    async inboxRevision(scope, accountId) {
      const row = await transactionOf(scope)
        .selectFrom('social.inbox_heads')
        .select('revision')
        .where('account_id', '=', accountId)
        .executeTakeFirst();
      return Number(row?.revision ?? 0);
    },

    cards: (scope, refs) => readContent('shared' in scope ? scope.shared.personal : scope, refs),
  };

  async function loadConversation(
    reader: PairLock | PersonalScopeTx,
    by: { readonly ownAccountId: string } & ({ conversationId: string } | { lineage: string }),
  ): Promise<Conversation | undefined> {
    let select = trxOf(reader)
      .selectFrom('social.conversations as c')
      .select([
        'c.conversation_id',
        'c.pair_id',
        'c.lineage',
        'c.last_sequence',
        'c.last_change_sequence',
        'c.last_activity_at',
        'c.closed_at',
      ]);
    // Under a pair lock only that friendship's conversations are in reach.
    if ('shared' in reader) select = select.where('c.pair_id', '=', reader.pair.id);
    select =
      'conversationId' in by
        ? select.where('c.conversation_id', '=', by.conversationId)
        : select.where('c.lineage', '=', by.lineage).where('c.closed_at', 'is', null);
    const conversation = await select.executeTakeFirst();
    if (!conversation) return undefined;
    const members = await trxOf(reader)
      .selectFrom('social.conversation_members')
      .selectAll()
      .where('conversation_id', '=', conversation.conversation_id)
      .execute();
    const own = members.find((member) => member.account_id === by.ownAccountId);
    if (!own) return undefined;
    const peer = members.find((member) => member.account_id !== by.ownAccountId);
    return {
      conversation: conversationOf(conversation),
      own: memberOf(own),
      peer: peer === undefined ? undefined : memberOf(peer),
    };
  }
}

type InboxQuery = Parameters<ConversationStore['inbox']>[2];

/**
 * One page of the caller's conversations, newest activity first, each with the other member and
 * the other person's profile joined in. Hidden conversations are left out here (see the
 * visibility condition), so a stranger and a missing conversation look the same.
 */
async function selectInboxRows(trx: Transaction<Database>, accountId: string, query: InboxQuery) {
  let select = trx
    .selectFrom('social.conversation_members as own')
    .innerJoin('social.conversations as c', 'c.conversation_id', 'own.conversation_id')
    .leftJoin('social.pairs as pair', (join) =>
      join.onRef('pair.pair_id', '=', 'c.pair_id').onRef('pair.accepted_lineage', '=', 'c.lineage'),
    )
    .leftJoin('social.conversation_members as peer', (join) =>
      join.onRef('peer.conversation_id', '=', 'c.conversation_id').onRef('peer.account_id', '<>', 'own.account_id'),
    )
    .leftJoin('social.profiles as profile', 'profile.account_id', 'peer.account_id')
    .leftJoin('identity.accounts as peer_account', 'peer_account.id', 'peer.account_id')
    .leftJoin('identity.universes as peer_universe', 'peer_universe.account_id', 'peer.account_id')
    .select([
      'c.conversation_id',
      'c.pair_id',
      'c.lineage',
      'c.last_sequence',
      'c.last_change_sequence',
      'c.last_activity_at',
      'c.closed_at',
      'own.account_id as own_account_id',
      'own.membership_id as own_membership_id',
      'own.membership_revision as own_membership_revision',
      'own.read_through_sequence as own_read_through',
      'own.muted as own_muted',
      'own.left_at as own_left_at',
      'peer.account_id as peer_account_id',
      'peer.membership_id as peer_membership_id',
      'peer.membership_revision as peer_membership_revision',
      'peer.read_through_sequence as peer_read_through',
      'peer.muted as peer_muted',
      'peer.left_at as peer_left_at',
      'profile.person_id',
      'profile.handle',
      'profile.display_name',
    ])
    .where('own.account_id', '=', accountId)
    .where('own.left_at', 'is', null)
    .where('c.last_sequence', '>', '0')
    .where((eb) =>
      eb.or([
        // A conversation lives only while the friendship lineage it began under does, and
        // while the other person is an active account...
        eb.and([
          eb('pair.pair_id', 'is not', null),
          eb('profile.person_id', 'is not', null),
          eb('peer_account.status', '=', 'active'),
          eb('peer_universe.status', '=', 'active'),
        ]),
        // ...except that history stays readable, with "Deleted account" in the other
        // person's place, after their account was deleted (their membership is gone).
        eb.and([eb('peer.account_id', 'is', null), eb('c.pair_id', 'is', null)]),
      ]),
    );
  if (query.after) {
    const at = new Date(query.after.activityMs);
    const id = query.after.conversationId;
    select = select.where((eb) =>
      eb.or([
        eb('c.last_activity_at', '<', at),
        eb.and([eb('c.last_activity_at', '=', at), eb('c.conversation_id', '>', id)]),
      ]),
    );
  }
  return select.orderBy('c.last_activity_at', 'desc').orderBy('c.conversation_id', 'asc').limit(query.limit).execute();
}

type InboxJoinRow = Awaited<ReturnType<typeof selectInboxRows>>[number];

/**
 * The last message of each listed conversation, by the (conversation, sequence) pair the listing
 * itself returned. The second statement of a READ COMMITTED read must not ask "what is last now":
 * a message that committed in between would then disagree with the `last_sequence` already read.
 */
export async function selectLastMessages(
  trx: Transaction<Database>,
  rows: readonly { readonly conversation_id: string; readonly last_sequence: string }[],
): Promise<ReadonlyMap<string, MessageRow>> {
  if (rows.length === 0) return new Map();
  const wanted = sql.join(rows.map((row) => sql`(${row.conversation_id}::uuid, ${row.last_sequence}::bigint)`));
  const found = await trx
    .selectFrom('social.messages as m')
    .leftJoin('social.profiles as p', 'p.account_id', 'm.author_account_id')
    .select(['m.conversation_id', ...MESSAGE_COLUMNS])
    .where(sql<boolean>`(m.conversation_id, m.sequence) in (${wanted})`)
    .execute();
  return new Map(found.map((row) => [row.conversation_id, messageOf(row)]));
}

const ownMemberOf = (row: InboxJoinRow): MemberRow =>
  memberOf({
    account_id: row.own_account_id,
    membership_id: row.own_membership_id,
    membership_revision: row.own_membership_revision,
    read_through_sequence: row.own_read_through,
    muted: row.own_muted,
    left_at: row.own_left_at,
  });

/** The other member, or nothing once their membership is gone with their account. */
const peerMemberOf = (row: InboxJoinRow): MemberRow | undefined =>
  row.peer_account_id === null
    ? undefined
    : memberOf({
        account_id: row.peer_account_id,
        membership_id: row.peer_membership_id!,
        membership_revision: row.peer_membership_revision!,
        read_through_sequence: row.peer_read_through!,
        muted: row.peer_muted!,
        left_at: row.peer_left_at,
      });

const peerPersonOf = (row: InboxJoinRow) =>
  row.person_id === null
    ? DELETED_PERSON
    : PublicPersonRefSchema.parse({
        kind: 'person',
        personId: row.person_id,
        handle: row.handle,
        displayName: row.display_name,
      });

const inboxRowOf = (row: InboxJoinRow, lastMessage: MessageRow | undefined): InboxRow => ({
  conversation: conversationOf(row),
  own: ownMemberOf(row),
  peer: peerMemberOf(row),
  peerPerson: peerPersonOf(row),
  lastMessage,
});
