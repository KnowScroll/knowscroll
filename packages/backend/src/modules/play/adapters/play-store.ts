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

interface LandmarkRow {
  readonly asset_id: string;
  readonly revision: number;
  readonly landmark_key: string;
  readonly landmark_name: string;
  readonly tier: 'gold' | 'plain';
  readonly earned_at: Date;
}

/**
 * `play.calls`, `play.scroll_results` (migration 0074) and `play.landmarks` (0077). Every row is the
 * caller's own and at their current privacy epoch. A call row is only ever inserted: the first lock
 * stands, so there is no update here. The order of the calls is the sequence `lock_seq`, never the
 * clock. A landmark is awarded once, in the transaction of the Final call that earned it.
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
    const landmark = await sql<LandmarkRow>`
      select asset_id, revision, landmark_key, landmark_name, tier, earned_at from play.landmarks
      where universe_id = ${universeId}::uuid and privacy_epoch = ${privacyEpoch}
        and asset_id = ${assetId}::uuid and revision = ${revision}`.execute(db);
    const row = tally.rows[0];
    const earned = landmark.rows[0];
    return {
      calls: calls.rows.map((call) => ({ stopId: call.stop_id, option: call.option, correct: call.correct })),
      tally: row === undefined ? NO_PLAY : { callsLocked: row.calls_locked, sparks: row.sparks, combo: row.combo },
      landmark:
        earned === undefined ? undefined : { key: earned.landmark_key, name: earned.landmark_name, tier: earned.tier },
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

  async insertLandmark(scope, landmark) {
    const db = recordingTransactionOf(scope);
    const { universeId, privacyEpoch } = scope.personal.authority;
    await sql`
      insert into play.landmarks (universe_id, privacy_epoch, asset_id, revision, landmark_key, landmark_name, tier)
      values (${universeId}::uuid, ${privacyEpoch}, ${landmark.assetId}::uuid, ${landmark.revision},
        ${landmark.key}, ${landmark.name}, ${landmark.tier})
      on conflict (universe_id, asset_id, revision) do nothing`.execute(db);
  },

  async listLandmarks(scope) {
    const { universeId, privacyEpoch } = scope.authority;
    const rows = await sql<LandmarkRow>`
      select asset_id, revision, landmark_key, landmark_name, tier, earned_at from play.landmarks
      where universe_id = ${universeId}::uuid and privacy_epoch = ${privacyEpoch}
      order by earned_at desc, asset_id, revision
      limit 200`.execute(transactionOf(scope));
    return rows.rows.map((row) => ({
      assetId: row.asset_id,
      revision: row.revision,
      key: row.landmark_key,
      name: row.landmark_name,
      tier: row.tier,
      earnedAt: row.earned_at,
    }));
  },
};
