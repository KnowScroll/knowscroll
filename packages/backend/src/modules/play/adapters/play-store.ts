import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import type { PlayStore } from '../application/ports.js';
import { NO_PLAY } from '../domain/results.js';

interface CallRow {
  readonly stop_id: string;
  readonly option: number;
  readonly correct: boolean;
}

interface TallyRow {
  readonly calls_locked: number;
  readonly sparks: number;
  readonly combo: number;
}

/**
 * `play.calls` and `play.scroll_results` (migration 0073). Every row is the caller's own and at
 * their current privacy epoch. A call row is only ever inserted: the first lock stands, so there is
 * no update here. The order of the calls is the sequence `lock_seq`, never the clock.
 */
export const playStore: PlayStore = {
  async readPlay(scope, assetId, revision) {
    const db = transactionOf(scope);
    const { universeId, privacyEpoch } = scope.authority;
    const calls = await sql<CallRow>`
      select stop_id, option, correct from play.calls
      where universe_id = ${universeId}::uuid and privacy_epoch = ${privacyEpoch}
        and asset_id = ${assetId}::uuid and revision = ${revision}
      order by lock_seq`.execute(db);
    const tally = await sql<TallyRow>`
      select calls_locked, sparks, combo from play.scroll_results
      where universe_id = ${universeId}::uuid and privacy_epoch = ${privacyEpoch}
        and asset_id = ${assetId}::uuid and revision = ${revision}`.execute(db);
    const row = tally.rows[0];
    return {
      calls: calls.rows.map((call) => ({ stopId: call.stop_id, option: call.option, correct: call.correct })),
      tally: row === undefined ? NO_PLAY : { callsLocked: row.calls_locked, sparks: row.sparks, combo: row.combo },
    };
  },

  async insertCall(scope, call, tally) {
    const db = recordingTransactionOf(scope);
    const { universeId, privacyEpoch } = scope.personal.authority;
    await sql`
      insert into play.calls (universe_id, privacy_epoch, asset_id, revision, stop_id, option, correct, command_id)
      values (${universeId}::uuid, ${privacyEpoch}, ${call.assetId}::uuid, ${call.revision}, ${call.stopId},
        ${call.option}, ${call.correct}, ${call.commandId}::uuid)`.execute(db);
    await sql`
      insert into play.scroll_results (universe_id, privacy_epoch, asset_id, revision, calls_locked, sparks, combo)
      values (${universeId}::uuid, ${privacyEpoch}, ${call.assetId}::uuid, ${call.revision},
        ${tally.callsLocked}, ${tally.sparks}, ${tally.combo})
      on conflict (universe_id, asset_id, revision) do update
        set calls_locked = excluded.calls_locked, sparks = excluded.sparks, combo = excluded.combo,
            updated_at = now()`.execute(db);
  },
};
