import { sql } from 'kysely';
import { sharedTransactionOf, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { QUEUED_ASK_LAPSES_MS } from '../domain/contribution.js';
import type { CapCounts } from '../domain/router.js';
import type { AiStore, AiTurnRow } from '../application/ports.js';
import { inhabitantOf, turnStateOf, turnTriggerOf } from './columns.js';

interface TurnColumns {
  turn_id: string;
  room_id: string;
  discussion_id: string;
  inhabitant: string;
  requested_by_account_id: string | null;
  state: string;
  created_at: Date | string;
  trigger: string;
  cause_message_id: string | null;
}

const turnOf = (row: TurnColumns): AiTurnRow => ({
  turnId: row.turn_id,
  roomId: row.room_id,
  discussionId: row.discussion_id,
  inhabitant: inhabitantOf(row.inhabitant),
  requestedByAccountId: row.requested_by_account_id,
  state: turnStateOf(row.state),
  createdAt: new Date(row.created_at),
  trigger: turnTriggerOf(row.trigger),
  causeMessageId: row.cause_message_id,
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** A room whose newest unprompted turn is older than this has no ratio to keep: the first turn after a long quiet is allowed. */
const RATIO_LOOKBACK_MS = 7 * DAY_MS;

/**
 * Postgres AI turns (migrations 0062 and 0070): the rate-bound ledger and the provenance of every AI message, asked
 * or unprompted. Every count here is read under the room lock, so a cap is exact.
 */
export const aiStore: AiStore = {
  async countAsks(lock, query) {
    // An ask is refunded only if it never reached the provider: a failed ask that was dispatched still counts.
    const earliest = query.dayStart < query.hourStart ? query.dayStart : query.hourStart;
    const row = await sql<{ room: string; person: string; person_requests: string }>`
      select count(*) filter (where room_id = ${lock.roomId}::uuid and created_at >= ${query.dayStart}
          and (state <> 'failed' or dispatched)) as room,
        count(*) filter (where requested_by_account_id = ${query.accountId}::uuid and created_at >= ${query.hourStart}
          and (state <> 'failed' or dispatched)) as person,
        count(*) filter (where requested_by_account_id = ${query.accountId}::uuid
          and created_at >= ${query.hourStart}) as person_requests
      from rooms.ai_turns
      where trigger = 'asked' and created_at >= ${earliest}
        and (room_id = ${lock.roomId}::uuid or requested_by_account_id = ${query.accountId}::uuid)`.execute(
      sharedTransactionOf(lock.shared),
    );
    return {
      room: Number(row.rows[0]?.room ?? 0),
      person: Number(row.rows[0]?.person ?? 0),
      personRequests: Number(row.rows[0]?.person_requests ?? 0),
    };
  },

  async openTurns(lock, discussionId, now) {
    const rows = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.ai_turns')
      .select('inhabitant')
      .where('discussion_id', '=', discussionId)
      .where('state', '=', 'queued')
      .where('created_at', '>', new Date(now.getTime() - QUEUED_ASK_LAPSES_MS))
      .execute();
    return rows.map((row) => inhabitantOf(row.inhabitant));
  },

  async lastUnansweredAsk(lock, discussionId, accountId, since) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.ai_turns')
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

  async insertAsk(lock, ask) {
    await sharedTransactionOf(lock.shared)
      .insertInto('rooms.ai_turns')
      .values({
        turn_id: ask.turnId,
        room_id: lock.roomId,
        discussion_id: ask.discussionId,
        inhabitant: ask.inhabitant,
        requested_by_account_id: ask.requestedByAccountId,
        command_id: ask.commandId,
        state: 'queued',
        created_at: ask.createdAt,
      })
      .execute();
  },

  async read(lock, turnId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.ai_turns')
      .select([
        'turn_id',
        'room_id',
        'discussion_id',
        'inhabitant',
        'requested_by_account_id',
        'state',
        'created_at',
        'trigger',
        'cause_message_id',
      ])
      .where('turn_id', '=', turnId)
      .where('room_id', '=', lock.roomId)
      .executeTakeFirst();
    return row === undefined ? undefined : turnOf(row);
  },

  async settle(lock, turnId, outcome) {
    const base = sharedTransactionOf(lock.shared)
      .updateTable('rooms.ai_turns')
      .where('turn_id', '=', turnId)
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
          dispatched: true,
        })
        .execute();
      return;
    }
    await base.set({ state: outcome.state, settled_at: outcome.at, dispatched: outcome.dispatched }).execute();
  },

  async forJob(scope, turnId) {
    const row = await transactionOf(scope)
      .selectFrom('rooms.ai_turns as turn')
      .innerJoin('identity.universes as universe', 'universe.account_id', 'turn.requested_by_account_id')
      .select([
        'turn.turn_id',
        'turn.room_id',
        'turn.discussion_id',
        'turn.inhabitant',
        'turn.requested_by_account_id',
        'turn.state',
        'turn.created_at',
        'turn.trigger',
        'turn.cause_message_id',
      ])
      .where('turn.turn_id', '=', turnId)
      .where('turn.trigger', '=', 'asked')
      .where('universe.id', '=', scope.authority.universeId)
      .executeTakeFirst();
    return row === undefined ? undefined : turnOf(row);
  },

  async decidedFor(lock, causeMessageId, trigger) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.ai_turns')
      .select('turn_id')
      .where('cause_message_id', '=', causeMessageId)
      .where('trigger', '=', trigger)
      .executeTakeFirst();
    return row !== undefined;
  },

  async capCounts(lock, query): Promise<CapCounts> {
    const trx = sharedTransactionOf(lock.shared);
    const hourStart = new Date(query.now.getTime() - HOUR_MS);
    const dayStart = new Date(Date.UTC(query.now.getUTCFullYear(), query.now.getUTCMonth(), query.now.getUTCDate()));
    // An unprompted turn counts toward the caps when it was allowed and cost a call: one that failed before it
    // reached the provider is handed back, and a refusal is not a turn. A turn that declined (nothing to add) counts.
    // The ratio looks at the newest turn that was posted or is still being prepared, not at one that declined.
    const counts = await sql<{
      room_hour: string;
      room_day: string;
      resident_hour: string;
      person_hour: string;
      last_at: Date | string | null;
    }>`
      select
        count(*) filter (where turn.created_at >= ${hourStart}) as room_hour,
        count(*) filter (where turn.created_at >= ${dayStart}) as room_day,
        count(*) filter (where turn.created_at >= ${hourStart} and turn.inhabitant = ${query.inhabitant}) as resident_hour,
        count(*) filter (where turn.created_at >= ${hourStart} and turn.inhabitant = 'skeptic'
          and cause.author_account_id = ${query.authorAccountId}::uuid) as person_hour,
        max(turn.created_at) filter (where turn.state in ('queued', 'completed')) as last_at
      from rooms.ai_turns turn
      left join rooms.messages cause on cause.message_id = turn.cause_message_id
      where turn.room_id = ${lock.roomId}::uuid and turn.trigger <> 'asked' and turn.state <> 'refused'
        and (turn.state <> 'failed' or turn.dispatched)
        and turn.created_at >= ${new Date(query.now.getTime() - RATIO_LOOKBACK_MS)}`.execute(trx);
    const row = counts.rows[0];
    const lastAt = row?.last_at === undefined || row.last_at === null ? undefined : new Date(row.last_at);
    const humans =
      lastAt === undefined
        ? undefined
        : await sql<{ humans: string }>`
            select count(*) as humans
            from rooms.messages message
            join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
            where discussion.room_id = ${lock.roomId}::uuid and message.author_kind = 'person'
              and message.author_account_id is not null and message.hidden_at is null
              and message.recorded_at > ${lastAt}`.execute(trx);
    return {
      ...(humans === undefined ? {} : { humanSinceLastTurn: Number(humans.rows[0]?.humans ?? 0) }),
      roomLastHour: Number(row?.room_hour ?? 0),
      roomToday: Number(row?.room_day ?? 0),
      residentLastHour: Number(row?.resident_hour ?? 0),
      personLastHour: Number(row?.person_hour ?? 0),
    };
  },

  async insertDecision(lock, decision) {
    const refused = decision.decision.kind === 'refused';
    await sharedTransactionOf(lock.shared)
      .insertInto('rooms.ai_turns')
      .values({
        turn_id: decision.turnId,
        room_id: lock.roomId,
        discussion_id: decision.discussionId,
        inhabitant: decision.inhabitant,
        trigger: decision.trigger,
        cause_message_id: decision.causeMessageId,
        state: refused ? 'refused' : 'queued',
        decided_by: decision.decision.kind === 'refused' ? decision.decision.cap : 'caps_clear',
        caps: JSON.stringify(decision.counts),
        created_at: decision.now,
        ...(refused ? { settled_at: decision.now } : {}),
      })
      .execute();
  },
};
