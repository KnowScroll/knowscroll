import { sql } from 'kysely';
import {
  completeSharedReceipt,
  findSharedReceipt,
  insertSharedReceipt,
  type CanonicalJson,
} from '../../../infrastructure/receipts/index.js';
import {
  enterSharedRoot,
  sharedTransactionOf,
  transactionOf,
} from '../../../infrastructure/postgres/personal-scope.js';
import type { MemberRow, RoomRow, RoomStore, Standing } from '../application/ports.js';
import { endedByOf, inhabitantOf, joinRuleOf, roleOf, statusOf, topicKindOf } from './columns.js';

/** The root kind of a room in the lock hierarchy and in shared receipts. */
export const ROOM_ROOT_KIND = 'rooms_room';

interface RoomColumns {
  room_id: string;
  name: string;
  description: string;
  guidelines: string | null;
  topic_kind: string;
  topic_id: string;
  join_rule: string;
  status: string;
  inhabitants: string[];
}

const ROOM_COLUMNS = [
  'room_id',
  'name',
  'description',
  'guidelines',
  'topic_kind',
  'topic_id',
  'join_rule',
  'status',
  'inhabitants',
] as const;

/** A room row as the use cases read it; the row type stays inside this adapter. */
export const roomOf = (row: RoomColumns): RoomRow => ({
  roomId: row.room_id,
  name: row.name,
  description: row.description,
  guidelines: row.guidelines,
  topic: { kind: topicKindOf(row.topic_kind), id: row.topic_id },
  joinRule: joinRuleOf(row.join_rule),
  status: statusOf(row.status),
  inhabitants: row.inhabitants.map(inhabitantOf),
});

const memberOf = (row: { account_id: string; role: string; ended_by: string | null }): MemberRow => ({
  accountId: row.account_id,
  role: roleOf(row.role),
  endedBy: row.ended_by === null ? null : endedByOf(row.ended_by),
});

/** Postgres room rows (migration 0062). The use cases decide who may read or write; this only runs queries. */
export const roomStore: RoomStore = {
  async lock(scope, roomId, mode) {
    const shared = await enterSharedRoot(scope, {
      kind: ROOM_ROOT_KIND,
      id: roomId,
      lock: async (trx) => {
        const row = trx.selectFrom('rooms.rooms').select('room_id').where('room_id', '=', roomId);
        const locked = await (mode === 'read' ? row.forShare() : row.forUpdate()).executeTakeFirst();
        return locked !== undefined;
      },
    });
    return shared === undefined ? undefined : { shared, roomId };
  },

  async standing(lock, accountId): Promise<Standing> {
    const trx = sharedTransactionOf(lock.shared);
    const room = await trx
      .selectFrom('rooms.rooms')
      .select(ROOM_COLUMNS)
      .where('room_id', '=', lock.roomId)
      .executeTakeFirstOrThrow();
    const own = await trx
      .selectFrom('rooms.members')
      .select(['account_id', 'role', 'ended_by'])
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    // An invitation counts while the member who made it is still a member.
    const invitation = await sql<{ invited: boolean }>`
      select exists (
        select 1 from rooms.invitations invitation
        join rooms.members inviter on inviter.room_id = invitation.room_id
          and inviter.account_id = invitation.inviter_account_id and inviter.ended_at is null
        where invitation.room_id = ${lock.roomId}::uuid and invitation.invitee_account_id = ${accountId}::uuid
      ) as invited`.execute(trx);
    const moderator = await trx
      .selectFrom('rooms.members')
      .select('account_id')
      .where('room_id', '=', lock.roomId)
      .where('role', '=', 'moderator')
      .where('ended_at', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return {
      room: roomOf(room),
      own: own === undefined ? undefined : memberOf(own),
      invited: invitation.rows[0]?.invited === true,
      hasModerator: moderator !== undefined,
    };
  },

  async anyMember(lock, accountIds) {
    if (accountIds.length === 0) return false;
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.members')
      .select('account_id')
      .where('room_id', '=', lock.roomId)
      .where('account_id', 'in', [...accountIds])
      .where('ended_at', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  },

  async memberOf(lock, accountId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.members')
      .select(['account_id', 'role', 'ended_by'])
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return row === undefined ? undefined : memberOf(row);
  },

  async listFor(scope, accountId) {
    const rows = await sql<RoomColumns & { standing: 'member' | 'moderator' | 'invited' }>`
      select room.room_id, room.name, room.description, room.guidelines, room.topic_kind, room.topic_id,
        room.join_rule, room.status, room.inhabitants,
        case when member.role = 'moderator' then 'moderator' else 'member' end as standing, member.joined_at as at
      from rooms.members member
      join rooms.rooms room on room.room_id = member.room_id
      where member.account_id = ${accountId}::uuid and member.ended_at is null
      union all
      select room.room_id, room.name, room.description, room.guidelines, room.topic_kind, room.topic_id,
        room.join_rule, room.status, room.inhabitants, 'invited' as standing, invitation.created_at as at
      from rooms.invitations invitation
      join rooms.rooms room on room.room_id = invitation.room_id
      where invitation.invitee_account_id = ${accountId}::uuid
        and exists (
          select 1 from rooms.members inviter
          where inviter.room_id = invitation.room_id and inviter.account_id = invitation.inviter_account_id
            and inviter.ended_at is null)
        and not exists (
          select 1 from rooms.members self
          where self.room_id = invitation.room_id and self.account_id = invitation.invitee_account_id
            and (self.ended_at is null or self.ended_by = 'removed'))
      order by at desc, room_id
      limit 100`.execute(transactionOf(scope));
    return rows.rows.map((row) => ({ room: roomOf(row), standing: row.standing }));
  },

  async join(lock, accountId, now) {
    const trx = sharedTransactionOf(lock.shared);
    const joined = await trx
      .insertInto('rooms.members')
      .values({ room_id: lock.roomId, account_id: accountId, role: 'member', joined_at: now })
      // A person who comes back is an ordinary member: a moderator's role is the operator's to give again.
      .onConflict((conflict) =>
        conflict
          .columns(['room_id', 'account_id'])
          .doUpdateSet({ ended_at: null, ended_by: null, joined_at: now, role: 'member' }),
      )
      .returning('role')
      .executeTakeFirstOrThrow();
    await trx
      .deleteFrom('rooms.invitations')
      .where('room_id', '=', lock.roomId)
      .where('invitee_account_id', '=', accountId)
      .execute();
    return roleOf(joined.role);
  },

  async end(lock, accountId, by, now) {
    await sharedTransactionOf(lock.shared)
      .updateTable('rooms.members')
      .set({ ended_at: now, ended_by: by, role: 'member' })
      .where('room_id', '=', lock.roomId)
      .where('account_id', '=', accountId)
      .where('ended_at', 'is', null)
      .execute();
  },

  async invite(lock, input) {
    await sharedTransactionOf(lock.shared)
      .insertInto('rooms.invitations')
      .values({
        room_id: lock.roomId,
        invitee_account_id: input.inviteeAccountId,
        inviter_account_id: input.inviterAccountId,
        created_at: input.now,
      })
      .onConflict((conflict) =>
        conflict.columns(['room_id', 'invitee_account_id']).doUpdateSet({
          inviter_account_id: input.inviterAccountId,
          created_at: input.now,
        }),
      )
      .execute();
  },

  async setStatus(lock, status) {
    await sharedTransactionOf(lock.shared)
      .updateTable('rooms.rooms')
      .set({ status })
      .where('room_id', '=', lock.roomId)
      .execute();
  },

  async findReceipt(lock, key) {
    const found = await findSharedReceipt(lock.shared, key);
    return found.kind === 'new' || found.kind === 'replay'
      ? found
      : { kind: 'refused', code: found.kind === 'key_reused' ? 'command_key_reused' : 'unavailable' };
  },
  async beginReceipt(lock, key) {
    await insertSharedReceipt(lock.shared, key);
  },
  async completeReceipt(lock, key, outcome) {
    await completeSharedReceipt(lock.shared, key, outcome as { readonly [key: string]: CanonicalJson });
  },
};
