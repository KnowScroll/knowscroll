import { sql } from 'kysely';
import { sharedTransactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { SummaryRow, SummaryStore } from '../application/ports.js';
import { summaryStateOf } from './columns.js';

interface SummaryColumns {
  summary_id: string;
  room_id: string;
  window_no: string;
  state: string;
  covers_from: Date | string;
  covers_through: Date | string;
  body: string | null;
  created_at: Date | string;
}

const COLUMNS = [
  'summary_id',
  'room_id',
  'window_no',
  'state',
  'covers_from',
  'covers_through',
  'body',
  'created_at',
] as const;

const summaryOf = (row: SummaryColumns): SummaryRow => ({
  summaryId: row.summary_id,
  roomId: row.room_id,
  windowNo: Number(row.window_no),
  state: summaryStateOf(row.state),
  coversFrom: new Date(row.covers_from),
  coversThrough: new Date(row.covers_through),
  body: row.body,
  createdAt: new Date(row.created_at),
});

/**
 * The summaries of a room's windows (migration 0076). The unique key (room, window) is the one-call-per-window cap,
 * and it holds under concurrency because the claim is one insert. Every method is one explicit query inside the room's
 * lock; none decides access.
 */
export const summaryStore: SummaryStore = {
  async claim(lock, summary) {
    const trx = sharedTransactionOf(lock.shared);
    const inserted = await trx
      .insertInto('rooms.summaries')
      .values({
        summary_id: summary.summaryId,
        room_id: lock.roomId,
        window_no: String(summary.windowNo),
        resident: 'skeptic',
        state: 'queued',
        covers_from: summary.coversFrom,
        covers_through: summary.coversThrough,
        created_at: summary.now,
      })
      .onConflict((conflict) => conflict.columns(['room_id', 'window_no']).doNothing())
      .returning(COLUMNS)
      .executeTakeFirst();
    if (inserted !== undefined) return { claimed: true, summary: summaryOf(inserted) };
    const existing = await trx
      .selectFrom('rooms.summaries')
      .select(COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('window_no', '=', String(summary.windowNo))
      .executeTakeFirstOrThrow();
    return { claimed: false, summary: summaryOf(existing) };
  },

  async read(lock, summaryId) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.summaries')
      .select(COLUMNS)
      .where('summary_id', '=', summaryId)
      .where('room_id', '=', lock.roomId)
      .executeTakeFirst();
    return row === undefined ? undefined : summaryOf(row);
  },

  async forWindow(lock, windowNo) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('rooms.summaries')
      .select(COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('window_no', '=', String(windowNo))
      .executeTakeFirst();
    return row === undefined ? undefined : summaryOf(row);
  },

  async settle(lock, summaryId, outcome) {
    const trx = sharedTransactionOf(lock.shared);
    // A summary that reached the provider stays dispatched whatever a later step believes.
    const dispatched = outcome.state === 'failed' ? outcome.dispatched : true;
    const base = trx
      .updateTable('rooms.summaries')
      .where('summary_id', '=', summaryId)
      .where('room_id', '=', lock.roomId);
    const changes =
      outcome.state === 'failed'
        ? { state: 'failed' as const, settled_at: outcome.at, dispatched: sql<boolean>`dispatched or ${dispatched}` }
        : {
            state: outcome.state,
            settled_at: outcome.at,
            body: outcome.state === 'ready' ? outcome.body : null,
            role_version: outcome.provenance.roleVersion,
            prompt_version: outcome.provenance.promptVersion,
            model: outcome.provenance.model,
            attempt_id: outcome.provenance.attemptId ?? null,
            dispatched: true,
          };
    const settled = await base.where('state', '=', 'queued').set(changes).executeTakeFirst();
    // Made stale while the call was running: its words are never stored, but the call was made and stays counted.
    if (settled.numUpdatedRows === 0n && dispatched)
      await base.where('state', '=', 'stale').set({ dispatched: true }).execute();
  },

  async markStale(lock, cause) {
    const trx = sharedTransactionOf(lock.shared);
    if ('coveringAt' in cause)
      await sql`
        update rooms.summaries set state = 'stale', body = null, settled_at = coalesce(settled_at, now())
        where room_id = ${lock.roomId}::uuid and state in ('queued', 'ready')
          and covers_from < ${cause.coveringAt} and covers_through >= ${cause.coveringAt}`.execute(trx);
    else
      await sql`
        update rooms.summaries summary set state = 'stale', body = null, settled_at = coalesce(settled_at, now())
        where summary.room_id = ${lock.roomId}::uuid and summary.state in ('queued', 'ready')
          and exists (
            select 1 from rooms.messages message
            join rooms.discussions discussion on discussion.discussion_id = message.discussion_id
            where discussion.room_id = summary.room_id and message.author_account_id = ${cause.byAccount}::uuid
              and message.recorded_at > summary.covers_from and message.recorded_at <= summary.covers_through)`.execute(
        trx,
      );
  },
};
