import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { EnqueueJob } from '../../../infrastructure/jobs/enqueue.js';
import { applyActionEvidenceQueue, projectEncounterActivityQueue } from '../../evidence/public.js';
import type { ChannelState, ChannelAction } from '../application/encounter-action.js';
import { originalRecordingGeneration, type ActionRecord } from '../application/ports.js';
import type { ExperienceRecordingEffects } from '../public.js';
import { fencePersonalRecording } from '../../../infrastructure/postgres/recording-scope.js';
import { applyRecordingChannel, rememberRecordingOrigin, readRecordingOrigin } from './recording-store.js';
import { recordAction, readExposure, writeSavedState } from './postgres-store.js';
export async function readChannels(scope: PersonalScopeTx, assetId: string): Promise<ChannelState> {
  const r = await sql<{
    saved_revision: number | null;
    liked: boolean;
    hidden: boolean;
    saved_origin_exposure_id: string | null;
    liked_origin_exposure_id: string | null;
    saved_origin_action_id: string | null;
    liked_origin_action_id: string | null;
  }>`select b.asset_revision as saved_revision,coalesce(a.liked,false) as liked,coalesce(a.hidden,false) as hidden,a.saved_origin_exposure_id,a.liked_origin_exposure_id,a.saved_origin_action_id,a.liked_origin_action_id from (select ${assetId}::uuid as asset_id) x left join experience.saved_items b on b.universe_id=${scope.authority.universeId}::uuid and b.asset_id=x.asset_id left join experience.action_state a on a.universe_id=${scope.authority.universeId}::uuid and a.asset_id=x.asset_id and a.privacy_epoch=${scope.authority.privacyEpoch}`.execute(
    transactionOf(scope),
  );
  const x = r.rows[0]!;
  return {
    saved: x.saved_revision !== null,
    ...(x.saved_revision !== null ? { savedRevision: x.saved_revision } : {}),
    liked: x.liked,
    hidden: x.hidden,
    ...(x.saved_origin_exposure_id ? { savedOriginExposureId: x.saved_origin_exposure_id } : {}),
    ...(x.liked_origin_exposure_id ? { likedOriginExposureId: x.liked_origin_exposure_id } : {}),
    ...(x.saved_origin_action_id ? { savedOriginActionId: x.saved_origin_action_id } : {}),
    ...(x.liked_origin_action_id ? { likedOriginActionId: x.liked_origin_action_id } : {}),
  };
}
async function channels(
  scope: PersonalScopeTx,
  a: ChannelAction,
  b: ChannelState,
  enqueue: EnqueueJob,
  legacy = false,
  legacyGrowth = true,
): Promise<{ changed: boolean }> {
  const db = transactionOf(scope),
    u = scope.authority.universeId,
    e = scope.authority.privacyEpoch;
  const save = a.kind === 'save' || a.kind === 'unsave',
    like = a.kind === 'like' || a.kind === 'unlike';
  const enabled = a.kind === 'save' || a.kind === 'like' || a.kind === 'hide';
  const changed = a.necessaryChanged ?? (save ? b.saved !== enabled : like ? b.liked !== enabled : !b.hidden);
  const origin =
    changed && (save || like)
      ? enabled
        ? a.exposureId
        : save
          ? b.savedOriginExposureId
          : b.likedOriginExposureId
      : undefined;
  const originAction =
    changed && (save || like)
      ? enabled
        ? a.actionId
        : save
          ? b.savedOriginActionId
          : b.likedOriginActionId
      : undefined;
  if (!legacy && save && changed)
    await writeSavedState(scope, { assetId: a.assetId, assetRevision: a.assetRevision, saved: enabled, at: a.at });
  const saveOrigin = save && changed ? (enabled ? a.exposureId : undefined) : b.savedOriginExposureId;
  const likeOrigin = like && changed ? (enabled ? a.exposureId : undefined) : b.likedOriginExposureId;
  const saveAction = save && changed ? (enabled && a.exposureId ? a.actionId : undefined) : b.savedOriginActionId;
  const likeAction = like && changed ? (enabled && a.exposureId ? a.actionId : undefined) : b.likedOriginActionId;
  await sql`insert into experience.action_state(universe_id,privacy_epoch,asset_id,liked,hidden,saved_origin_exposure_id,liked_origin_exposure_id,saved_origin_action_id,liked_origin_action_id) values(${u}::uuid,${e},${a.assetId}::uuid,${like ? enabled : b.liked},${a.kind === 'hide' ? true : b.hidden},${saveOrigin ?? null}::uuid,${likeOrigin ?? null}::uuid,${saveAction ?? null}::uuid,${likeAction ?? null}::uuid) on conflict(universe_id,asset_id) do update set privacy_epoch=excluded.privacy_epoch,liked=excluded.liked,hidden=excluded.hidden,saved_origin_exposure_id=excluded.saved_origin_exposure_id,liked_origin_exposure_id=excluded.liked_origin_exposure_id,saved_origin_action_id=excluded.saved_origin_action_id,liked_origin_action_id=excluded.liked_origin_action_id,recording_saved_state=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_saved_state else null end,recording_saved_origin_exposure_id=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_saved_origin_exposure_id else null end,recording_saved_origin_action_id=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_saved_origin_action_id else null end,recording_saved_decision_action_id=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_saved_decision_action_id else null end,recording_liked_state=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_liked_state else null end,recording_liked_origin_exposure_id=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_liked_origin_exposure_id else null end,recording_liked_origin_action_id=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_liked_origin_action_id else null end,recording_liked_decision_action_id=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_liked_decision_action_id else null end,recording_channel_revision=case when experience.action_state.privacy_epoch=excluded.privacy_epoch then experience.action_state.recording_channel_revision else 0 end`.execute(
    db,
  );
  await sql`insert into experience.action_links(universe_id,privacy_epoch,action_id,provided_exposure_id,credited_exposure_id,origin_action_id) values(${u}::uuid,${e},${a.actionId}::uuid,${a.exposureId ?? null}::uuid,${origin ?? null}::uuid,${originAction ?? null}::uuid)`.execute(
    db,
  );
  if (origin && legacyGrowth) {
    const x = await readExposure(scope, origin);
    if (!x?.activatedAt || x.privacyEpoch !== e || x.assetId !== a.assetId)
      throw new Error('ACTION_ORIGIN_LINEAGE_INVALID');
    await sql`insert into experience.encounter_activity_inputs(universe_id,privacy_epoch,exposure_id) values(${u}::uuid,${e},${origin}::uuid) on conflict(universe_id,exposure_id) do nothing`.execute(
      db,
    );
    await sql`update experience.encounter_activity_inputs set ${sql.ref(save ? 'saved' : 'liked')}=${enabled},action_revision=action_revision+1 where universe_id=${u}::uuid and privacy_epoch=${e} and exposure_id=${origin}::uuid and ${sql.ref(save ? 'saved' : 'liked')}<>${enabled}`.execute(
      db,
    );
    await enqueue(scope, projectEncounterActivityQueue, { v: 1, universeId: u, privacyEpoch: e, exposureId: origin });
  }
  return { changed };
}
export function makeCommitAction(enqueue: EnqueueJob, effects?: ExperienceRecordingEffects) {
  return async (scope: PersonalScopeTx, a: ChannelAction, b: ChannelState) => {
    const { actionId: id, exposureId: _exposureId, ...rest } = a;
    await recordAction(scope, { ...rest, id, kind: a.kind });
    const g = originalRecordingGeneration(a);
    const gate = await fencePersonalRecording(scope, g);
    if (gate.kind === 'unavailable') throw new Error('RECORDING_AUTHORITY_UNAVAILABLE');
    const cap = gate.kind === 'recording' && (effects || gate.scope.generation === 1) ? gate.scope : undefined;
    await rememberRecordingOrigin(
      scope,
      { commandId: a.commandId, operation: a.operation ?? 'experience.encounter-action-v0' },
      g,
      cap?.generation,
      a.at,
    );
    const result = await channels(scope, a, b, enqueue, false, !effects && cap?.generation === 1);
    const recording =
      effects && cap ? await applyRecordingChannel(cap, a, result.changed, effects) : { changed: false as const };
    if (effects && cap) await effects.enqueueActionEvidence(cap, a.actionId);
    else if (cap?.generation === 1)
      await enqueue(scope, applyActionEvidenceQueue, {
        v: 1,
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        actionId: a.actionId,
      });
    return { ...result, recording };
  };
}
/** Legacy application has already changed Saved; retain original linkage for a legacy Unsave. */
export function makeRecordLegacyAction(enqueue: EnqueueJob, effects?: ExperienceRecordingEffects) {
  return async (scope: PersonalScopeTx, a: ActionRecord) => {
    if (a.kind !== 'save' && a.kind !== 'unsave') throw new Error('LEGACY_ACTION_INVALID');
    const current = await readChannels(scope, a.assetId);
    const before = { ...current, saved: a.kind === 'save' ? false : current.savedOriginExposureId !== undefined };
    // No-op legacy Save must not clear a prior linked origin; infer it from the retained origin/state.
    if (a.kind === 'save' && current.savedOriginExposureId) before.saved = true;
    await recordAction(scope, a);
    const g = originalRecordingGeneration(a),
      gate = await fencePersonalRecording(scope, g);
    if (gate.kind === 'unavailable') throw new Error('RECORDING_AUTHORITY_UNAVAILABLE');
    const cap = gate.kind === 'recording' && (effects || gate.scope.generation === 1) ? gate.scope : undefined;
    await rememberRecordingOrigin(
      scope,
      { commandId: a.commandId, operation: a.operation ?? 'experience.apply-action' },
      g,
      cap?.generation,
      a.at,
    );
    const actual = { actionId: a.id, ...a };
    const result = await channels(scope, actual, before, enqueue, true, !effects && cap?.generation === 1);
    return {
      recording:
        effects && cap
          ? await applyRecordingChannel(cap, actual, a.necessaryChanged ?? result.changed, effects)
          : { changed: false as const },
    };
  };
}

/** Legacy caller queue seam reads the stored original disposition, never server-current. */
export function makeEnqueueActionEvidence(enqueue: EnqueueJob, effects?: ExperienceRecordingEffects) {
  return async (
    scope: PersonalScopeTx,
    payload: { readonly v: 1; readonly universeId: string; readonly privacyEpoch: number; readonly actionId: string },
  ): Promise<void> => {
    const row = await transactionOf(scope)
      .selectFrom('experience.actions')
      .select('command_id')
      .where('universe_id', '=', scope.authority.universeId)
      .where('id', '=', payload.actionId)
      .executeTakeFirst();
    if (!row) return;
    const origin = await readRecordingOrigin(scope, row.command_id);
    if (!origin?.eligible) return;
    const gate = await fencePersonalRecording(scope, origin.eligible);
    if (gate.kind !== 'recording') return;
    if (effects) await effects.enqueueActionEvidence(gate.scope, payload.actionId);
    else if (gate.scope.generation === 1) await enqueue(scope, applyActionEvidenceQueue, payload);
  };
}
