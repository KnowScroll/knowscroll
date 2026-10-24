import { sql } from 'kysely';
import { sharedTransactionOf, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { QUEUED_ASK_LAPSES_MS } from '../domain/contribution.js';
import type { AiRequestRow, AiStore } from '../application/ports.js';
import { askStateOf, inhabitantOf } from './columns.js';

interface RequestColumns {
  request_id: string;
  room_id: string;
  discussion_id: string;
  inhabitant: string;
  requested_by_account_id: string | null;
  state: string;
  created_at: Date | string;
}

const REQUEST_COLUMNS = [
  'request_id',
  'room_id',
  'discussion_id',
  'inhabitant',
  'requested_by_account_id',
  'state',
  'created_at',
] as const;

const requestOf = (row: RequestColumns): AiRequestRow => ({
  requestId: row.request_id,
  roomId: row.room_id,
  discussionId: row.discussion_id,
  inhabitant: inhabitantOf(row.inhabitant),
  requestedByAccountId: row.requested_by_account_id,
  state: askStateOf(row.state),
  createdAt: new Date(row.created_at),
});

/** Postgres AI inhabitant requests (migration 0062): the rate-bound ledger and the provenance of each contribution. */
export const aiStore: AiStore = {
  async countAsks(lock, query) {
    const row = await sql<{ room: string; person: string }>`
      select count(*) filter (where room_id = ${lock.roomId}::uuid) as room,
        count(*) filter (where requested_by_account_id = ${query.accountId}::uuid) as person
      from rooms.ai_requests
      where created_at >= ${query.since} and state <> 'failed'
        and (room_id = ${lock.roomId}::uuid or requested_by_account_id = ${query.accountId}::uuid)`.execute(
      sharedTransactionOf(lock.shared),
    );
    return { room: Number(row.rows[0]?.room ?? 0), person: Number(row.rows[0]?.person ?? 0) };
  },

  async openAsks(lock, discussionId, now) {
    const rows = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.ai_requests')
      .select('inhabitant')
      .where('discussion_id', '=', discussionId)
      .where('state', '=', 'queued')
      .where('created_at', '>', new Date(now.getTime() - QUEUED_ASK_LAPSES_MS))
      .execute();
    return rows.map((row) => inhabitantOf(row.inhabitant));
  },

  async lastUnansweredAsk(lock, discussionId, accountId, since) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.ai_requests')
      .select(['inhabitant', 'state'])
      .where('discussion_id', '=', discussionId)
      .where('requested_by_account_id', '=', accountId)
      .where('state', 'in', ['declined', 'failed'])
      .where('settled_at', '>=', since)
      .orderBy('settled_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return { inhabitant: inhabitantOf(row.inhabitant), state: row.state === 'declined' ? 'declined' : 'failed' };
  },

  async insert(lock, request) {
    await sharedTransactionOf(lock.shared)
      .insertInto('rooms.ai_requests')
      .values({
        request_id: request.requestId,
        room_id: lock.roomId,
        discussion_id: request.discussionId,
        inhabitant: request.inhabitant,
        requested_by_account_id: request.requestedByAccountId,
        command_id: request.commandId,
        state: 'queued',
        created_at: request.createdAt,
      })
      .execute();
  },

  async read(lock, requestId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.ai_requests')
      .select(REQUEST_COLUMNS)
      .where('request_id', '=', requestId)
      .where('room_id', '=', lock.roomId)
      .executeTakeFirst();
    return row === undefined ? undefined : requestOf(row);
  },

  async settle(lock, requestId, outcome) {
    const trx = sharedTransactionOf(lock.shared);
    const base = trx
      .updateTable('rooms.ai_requests')
      .where('request_id', '=', requestId)
      .where('room_id', '=', lock.roomId)
      .where('state', '=', 'queued');
    if (outcome.state === 'completed') {
      await base
        .set({
          state: 'completed',
          settled_at: outcome.at,
          message_id: outcome.messageId,
          role_version: outcome.provenance.roleVersion,
          prompt_version: outcome.provenance.promptVersion,
          model: outcome.provenance.model,
          attempt_id: outcome.provenance.attemptId ?? null,
        })
        .execute();
      return;
    }
    await base.set({ state: outcome.state, settled_at: outcome.at }).execute();
  },

  async forJob(scope, requestId) {
    const row = await transactionOf(scope)
      .selectFrom('rooms.ai_requests as request')
      .innerJoin('identity.universes as universe', 'universe.account_id', 'request.requested_by_account_id')
      .select([
        'request.request_id',
        'request.room_id',
        'request.discussion_id',
        'request.inhabitant',
        'request.requested_by_account_id',
        'request.state',
        'request.created_at',
      ])
      .where('request.request_id', '=', requestId)
      .where('universe.id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return row === undefined ? undefined : requestOf(row);
  },
};
