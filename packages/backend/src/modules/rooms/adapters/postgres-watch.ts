import { sql } from 'kysely';
import { sharedTransactionOf, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { WatchStore } from '../application/ports.js';
import type { WatchSessionRow } from '../application/watch-ports.js';

const trxOf = (lock: Parameters<WatchStore['latest']>[0]) => sharedTransactionOf(lock.shared);

interface Columns {
  session_id: string;
  asset_id: string;
  asset_revision: number;
  title: string;
  duration_ms: number;
  started_by: string | null;
  starts_at: Date | string;
  stopped_at: Date | string | null;
}

const COLUMNS = [
  'session_id',
  'asset_id',
  'asset_revision',
  'title',
  'duration_ms',
  'started_by',
  'starts_at',
  'stopped_at',
] as const;

const rowOf = (row: Columns): WatchSessionRow => ({
  sessionId: row.session_id,
  assetId: row.asset_id,
  assetRevision: row.asset_revision,
  title: row.title,
  durationMs: row.duration_ms,
  startedBy: row.started_by,
  startsAt: new Date(row.starts_at),
  stoppedAt: row.stopped_at === null ? null : new Date(row.stopped_at),
});

/**
 * The room's Watch together sessions and their viewers (migration 0093). Every method is one explicit query inside the room's lock;
 * none decides access or a count. At most one session per room has not been stopped (a partial unique index), so two starts at once
 * cannot make a second. There is no column for a position, a pause or a time of anyone's own.
 */
export const watchStore: WatchStore = {
  async live(lock, rowLock) {
    const query = trxOf(lock)
      .selectFrom('rooms.watch_sessions')
      .select(COLUMNS)
      .where('room_id', '=', lock.roomId)
      .where('stopped_at', 'is', null);
    const found = await (
      rowLock === 'share' ? query.forShare() : rowLock === 'update' ? query.forUpdate() : query
    ).executeTakeFirst();
    return found === undefined ? undefined : rowOf(found);
  },

  async latest(lock) {
    const found = await trxOf(lock)
      .selectFrom('rooms.watch_sessions')
      .select(COLUMNS)
      .where('room_id', '=', lock.roomId)
      .orderBy('starts_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    return found === undefined ? undefined : rowOf(found);
  },

  async insert(lock, session) {
    await trxOf(lock)
      .insertInto('rooms.watch_sessions')
      .values({
        session_id: session.sessionId,
        room_id: lock.roomId,
        asset_id: session.assetId,
        asset_revision: session.assetRevision,
        title: session.title,
        duration_ms: session.durationMs,
        started_by: session.startedBy,
        starts_at: session.startsAt,
      })
      .execute();
  },

  async addViewer(lock, sessionId, accountId, now) {
    const inserted = await trxOf(lock)
      .insertInto('rooms.watch_viewers')
      .values({ session_id: sessionId, account_id: accountId, joined_at: now })
      .onConflict((conflict) => conflict.columns(['session_id', 'account_id']).doNothing())
      .executeTakeFirst();
    return (inserted.numInsertedOrUpdatedRows ?? 0n) > 0n;
  },

  async removeViewer(lock, sessionId, accountId) {
    const removed = await trxOf(lock)
      .deleteFrom('rooms.watch_viewers')
      .where('session_id', '=', sessionId)
      .where('account_id', '=', accountId)
      .executeTakeFirst();
    return (removed.numDeletedRows ?? 0n) > 0n;
  },

  async viewers(lock, sessionId) {
    const found = await trxOf(lock)
      .selectFrom('rooms.watch_viewers')
      .select('account_id')
      .where('session_id', '=', sessionId)
      .orderBy('account_id')
      .execute();
    return found.map((row) => row.account_id);
  },

  async stop(lock, sessionId, at) {
    const updated = await trxOf(lock)
      .updateTable('rooms.watch_sessions')
      .set({ stopped_at: at })
      .where('session_id', '=', sessionId)
      .where('stopped_at', 'is', null)
      .executeTakeFirst();
    return (updated.numUpdatedRows ?? 0n) > 0n;
  },

  async clearViewers(lock, sessionId) {
    await trxOf(lock).deleteFrom('rooms.watch_viewers').where('session_id', '=', sessionId).execute();
  },

  async startedSince(lock, since) {
    const found = await trxOf(lock)
      .selectFrom('rooms.watch_sessions')
      .select((builder) => builder.fn.countAll<string>().as('total'))
      .where('room_id', '=', lock.roomId)
      .where('starts_at', '>=', since)
      .executeTakeFirstOrThrow();
    return Number(found.total);
  },

  async purge(lock, before) {
    const trx = trxOf(lock);
    const old = sql`(select session_id from rooms.watch_sessions
      where room_id = ${lock.roomId}::uuid and stopped_at is not null and stopped_at < ${before})`;
    await sql`delete from rooms.watch_viewers where session_id in ${old}`.execute(trx);
    await sql`delete from rooms.watch_sessions where session_id in ${old}`.execute(trx);
  },

  async forgetMember(lock, accountId) {
    const trx = trxOf(lock);
    const own = sql`(select session_id from rooms.watch_sessions where room_id = ${lock.roomId}::uuid)`;
    await sql`delete from rooms.watch_viewers where account_id = ${accountId}::uuid and session_id in ${own}`.execute(
      trx,
    );
    await sql`update rooms.watch_sessions set started_by = null
      where room_id = ${lock.roomId}::uuid and started_by = ${accountId}::uuid`.execute(trx);
  },

  async liveRooms(scope, roomIds, now) {
    if (roomIds.length === 0) return new Set();
    const found = await sql<{ room_id: string }>`
      select distinct room_id from rooms.watch_sessions
      where room_id = any(${roomIds}::uuid[]) and stopped_at is null
        and starts_at + duration_ms * interval '1 millisecond' > ${now}`.execute(transactionOf(scope));
    return new Set(found.rows.map((row) => row.room_id));
  },
};
