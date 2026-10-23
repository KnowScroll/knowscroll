import { sql } from 'kysely';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import type { ReadRecordingLifecycle, RecordingScopeTx } from '../../identity/public.js';
import type { ReadRecordingChannelSelection } from '../public.js';
/** Exact lifecycle/certificate/pointer probes only; no history scan or initialization on read. */
export function recordingChannelSelection(lifecycle: ReadRecordingLifecycle): ReadRecordingChannelSelection {
  if (typeof lifecycle !== 'function') throw new Error('RECORDING_LIFECYCLE_REQUIRED');
  return async (scope, input) => {
    const life = await lifecycle(scope);
    if (life.kind !== 'fresh') return life;
    const result = await sql<{
      first_decision_action_id: string | null;
      state: boolean | null;
      decision: string | null;
      origin_exposure: string | null;
      origin_action: string | null;
      revision: number | null;
    }>`
   select c.first_decision_action_id,a.recording_channel_revision as revision,
    ${sql.ref(`a.recording_${input.channel}_state`)} as state,${sql.ref(`a.recording_${input.channel}_decision_action_id`)} as decision,
    ${sql.ref(`a.recording_${input.channel}_origin_exposure_id`)} as origin_exposure,${sql.ref(`a.recording_${input.channel}_origin_action_id`)} as origin_action
   from experience.recording_channel_certificates c left join experience.action_state a
    on a.universe_id=c.universe_id and a.privacy_epoch=c.privacy_epoch and a.asset_id=c.asset_id
   where c.universe_id=${scope.personal.authority.universeId}::uuid and c.privacy_epoch=${scope.personal.authority.privacyEpoch}
    and c.asset_id=${input.assetId}::uuid and c.channel=${input.channel}`.execute(recordingTransactionOf(scope));
    const r = result.rows[0];
    if (!r) return { kind: 'unavailable' };
    if (r.first_decision_action_id === null)
      return r.state === null ? { kind: 'certified_empty' } : { kind: 'unavailable' };
    if (
      r.state === null ||
      r.decision === null ||
      r.revision === null ||
      (r.origin_action === null) !== (r.origin_exposure === null)
    )
      return { kind: 'unavailable' };
    return {
      kind: 'tracked',
      state: r.state,
      decisionActionId: r.decision,
      originExposureId: r.origin_exposure,
      originActionId: r.origin_action,
      revision: r.revision,
    };
  };
}
/** A genuine accepted eligible action initializes metadata, never a fake false decision. */
export async function initializeChannelCertificate(
  scope: RecordingScopeTx,
  input: { assetId: string; channel: 'saved' | 'liked'; actionId: string; at: Date },
  lifecycle: ReadRecordingLifecycle,
): Promise<boolean> {
  const state = await lifecycle(scope);
  if (state.kind === 'unavailable') throw new Error('RECORDING_LIFECYCLE_UNAVAILABLE');
  if (state.kind !== 'fresh') return false;
  await sql`insert into experience.recording_channel_certificates(universe_id,privacy_epoch,asset_id,channel,initialized_generation,initialized_at,initializing_action_id)
 values(${scope.personal.authority.universeId}::uuid,${scope.personal.authority.privacyEpoch},${input.assetId}::uuid,${input.channel},${scope.generation},${input.at},${input.actionId}::uuid)
 on conflict(universe_id,privacy_epoch,asset_id,channel) do nothing`.execute(recordingTransactionOf(scope));
  return true;
}
export async function certifyFirstDecision(
  scope: RecordingScopeTx,
  input: { assetId: string; channel: 'saved' | 'liked'; actionId: string },
): Promise<void> {
  await sql`update experience.recording_channel_certificates set first_decision_action_id=${input.actionId}::uuid
 where universe_id=${scope.personal.authority.universeId}::uuid and privacy_epoch=${scope.personal.authority.privacyEpoch}
 and asset_id=${input.assetId}::uuid and channel=${input.channel} and first_decision_action_id is null`.execute(
    recordingTransactionOf(scope),
  );
}
