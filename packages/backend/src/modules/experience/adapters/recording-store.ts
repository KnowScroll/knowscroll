import {
  initializeChannelCertificate,
  certifyFirstDecision,
  recordingChannelSelection,
} from './channel-certification.js';
import { z } from 'zod';
import { sql } from 'kysely';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { fencePersonalRecording, recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import { requestHash, type CanonicalJson } from '../../../infrastructure/receipts/index.js';
import type {
  FenceOwnAccount,
  ReadRecordingLifecycle,
  PersonalAuthority,
  PersonalScopeTx,
  RecordingScopeTx,
  ScopeOutcome,
  WithPersonalScope,
} from '../../identity/public.js';
import type { ReadEncounterAttribution } from '../../content/public.js';
import type { ExperienceRecordingEffects, ReadRecordingSegment, RecordingChannelsResult } from '../public.js';
import type { CommandKey, RecordingCommandHooks } from '../application/ports.js';
import type { ChannelAction } from '../application/encounter-action.js';
import { readExposure } from './postgres-store.js';

/** Genuine own UPDATE fence precedes every domain row/receipt, including after a wait. */
export function withExperienceScope(withScope: WithPersonalScope, fenceOwn: FenceOwnAccount): WithPersonalScope {
  return async <T>(
    authority: PersonalAuthority,
    work: (scope: PersonalScopeTx) => Promise<T>,
  ): Promise<ScopeOutcome<T>> => {
    const entered = await withScope(authority, async (scope) => {
      if ((await fenceOwn(scope)).kind !== 'active') return { active: false as const };
      return { active: true as const, value: await work(scope) };
    });
    if (entered.kind !== 'entered') return entered;
    return entered.value.active
      ? { kind: 'entered', value: entered.value.value }
      : { kind: 'refused', refusal: { kind: 'account_mismatch' } };
  };
}
export async function rememberRecordingOrigin(
  scope: PersonalScopeTx,
  key: Pick<CommandKey, 'commandId' | 'operation'>,
  originalGeneration: number | undefined,
  eligibleGeneration: number | undefined,
  at: Date,
): Promise<void> {
  await sql`insert into experience.recording_command_origins(universe_id,privacy_epoch,command_id,operation,original_generation,eligible_generation,recorded_at)
    values(${scope.authority.universeId}::uuid,${scope.authority.privacyEpoch},${key.commandId}::uuid,${key.operation},${originalGeneration ?? null},${eligibleGeneration ?? null},${at})`.execute(
    transactionOf(scope),
  );
}
/**
 * Whether an exposure was activated by an offer's activation made while recording was on: the command that created it
 * remembered a generation recording was eligible at. An exposure activated while recording was paused, or at a generation the
 * device did not hold, has none. Reads the person's own rows by exact key.
 */
export async function activatedWhileRecording(scope: PersonalScopeTx, exposureId: string): Promise<boolean> {
  const r = await sql<{
    eligible_generation: number | null;
  }>`select o.eligible_generation from experience.exposures x
    join experience.recording_command_origins o on o.universe_id=x.universe_id and o.privacy_epoch=x.privacy_epoch and o.command_id=x.command_id
    where x.universe_id=${scope.authority.universeId}::uuid and x.privacy_epoch=${scope.authority.privacyEpoch} and x.id=${exposureId}::uuid
      and x.activated_at is not null and o.operation='experience.activate-offer-v0'`.execute(transactionOf(scope));
  return r.rows[0] !== undefined && r.rows[0].eligible_generation !== null;
}
export async function readRecordingOrigin(
  scope: PersonalScopeTx,
  commandId: string,
): Promise<{ original: number | undefined; eligible: number | undefined } | undefined> {
  const r = await sql<{
    original_generation: number | null;
    eligible_generation: number | null;
  }>`select original_generation,eligible_generation from experience.recording_command_origins where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and command_id=${commandId}::uuid`.execute(
    transactionOf(scope),
  );
  return r.rows[0]
    ? { original: r.rows[0].original_generation ?? undefined, eligible: r.rows[0].eligible_generation ?? undefined }
    : undefined;
}
export async function legacyRecording(
  scope: PersonalScopeTx,
  original: number | undefined,
  lifecycle: ReadRecordingLifecycle,
): Promise<RecordingScopeTx | undefined> {
  const result = await fencePersonalRecording(scope, original);
  if (result.kind === 'unavailable') throw new Error('EXPERIENCE_RECORDING_AUTHORITY_UNAVAILABLE');
  if (result.kind !== 'recording' || result.scope.generation !== 1) return undefined;
  const state = await lifecycle(result.scope);
  if (state.kind === 'unavailable') throw new Error('RECORDING_LIFECYCLE_UNAVAILABLE');
  if (state.kind === 'fresh') throw new Error('EXPERIENCE_RECORDING_EFFECTS_REQUIRED');
  return state.kind === 'legacy_unknown' ? result.scope : undefined;
}

export function recordingCommandHooks(
  metadata: ReadEncounterAttribution,
  lifecycle: ReadRecordingLifecycle,
  effects?: ExperienceRecordingEffects,
): RecordingCommandHooks {
  if (typeof lifecycle !== 'function') throw new Error('RECORDING_LIFECYCLE_REQUIRED');
  return {
    async fence(scope, original) {
      const gate = await fencePersonalRecording(scope, original);
      const state = gate.kind === 'recording' ? await lifecycle(gate.scope) : undefined;
      if (state?.kind === 'unavailable') throw new Error('RECORDING_LIFECYCLE_UNAVAILABLE');
      if (!effects && state?.kind === 'fresh') throw new Error('EXPERIENCE_RECORDING_EFFECTS_REQUIRED');
      if (state?.kind === 'not_ready') return { kind: 'generation_required' };
      return !effects && gate.kind === 'recording' && gate.scope.generation !== 1
        ? { kind: 'generation_required' }
        : gate;
    },
    remember: rememberRecordingOrigin,
    async offerOrigin(scope, offerId) {
      const r = await sql<{
        eligible_generation: number | null;
      }>`select eligible_generation from experience.recording_offer_origins where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and offer_id=${offerId}::uuid`.execute(
        transactionOf(scope),
      );
      return r.rows[0]?.eligible_generation ?? undefined;
    },
    async bindOfferOrigins(scope, offerIds, commandId, generation) {
      if (offerIds.length > 3) throw new Error('RECORDING_OFFER_BOUND');
      for (const id of offerIds)
        await sql`insert into experience.recording_offer_origins(universe_id,privacy_epoch,offer_id,original_command_id,eligible_generation) values(${scope.authority.universeId}::uuid,${scope.authority.privacyEpoch},${id}::uuid,${commandId}::uuid,${generation ?? null})`.execute(
          transactionOf(scope),
        );
    },
    async activation(scope, id, commandId, at, offer) {
      // Recording-aware consumers must supply the REQUIRED effect. Legacy clocks remain v1.
      if (!effects) return;
      const db = recordingTransactionOf(scope),
        p = scope.personal,
        g = scope.generation,
        u = p.authority.universeId,
        epoch = p.authority.privacyEpoch;
      const exposure = await readExposure(p, id);
      if (!exposure?.activatedAt || exposure.privacyEpoch !== epoch) throw new Error('RECORDING_ACTIVATION_LINEAGE');
      const m = await metadata(p, { assetId: exposure.assetId, assetRevision: exposure.assetRevision });
      if (!m) return; // Necessary activation remains valid; no invented attribution/session.
      const payload = JSON.stringify(m),
        hash = requestHash('experience.recording-attribution', JSON.parse(payload) as CanonicalJson);
      const old = await sql<{
        attribution_sha256: string;
      }>`select attribution_sha256 from experience.recording_segments where universe_id=${u}::uuid and privacy_epoch=${epoch} and exposure_id=${id}::uuid and recording_generation<=${g} order by recording_generation desc limit 1`.execute(
        db,
      );
      if (old.rows[0] && old.rows[0].attribution_sha256 !== hash) return;
      // The server timestamp is sampled in this accepted transaction, never client ACK time.
      await sql`insert into experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation,asset_id,asset_revision,kind,explanation_unit_id,attribution_sha256,attribution_payload,initialized_at,first_eligible_activation_at,first_eligible_activation_command_id)
        values(${u}::uuid,${epoch},${id}::uuid,${g},${exposure.assetId}::uuid,${exposure.assetRevision},${exposure.kind},${m.explanationUnitId},${hash},${payload}::jsonb,${at},${at},${commandId}::uuid)
        on conflict(universe_id,exposure_id,recording_generation) do update set first_eligible_activation_at=coalesce(experience.recording_segments.first_eligible_activation_at,excluded.first_eligible_activation_at),first_eligible_activation_command_id=coalesce(experience.recording_segments.first_eligible_activation_command_id,excluded.first_eligible_activation_command_id)`.execute(
        db,
      );
      await sql`insert into experience.recording_segment_inputs(universe_id,privacy_epoch,exposure_id,recording_generation) values(${u}::uuid,${epoch},${id}::uuid,${g}) on conflict do nothing`.execute(
        db,
      );
      await effects.startSession(scope, { exposureId: id, sessionId: commandId, serverStartedAt: at });
      // A reactivation/session restart is no new navigation fact.
      if (offer?.fresh && offer.eligibleGeneration === g) {
        const prior = await sql<{
          first_eligible_activation_at: Date;
        }>`select first_eligible_activation_at from experience.recording_segments where universe_id=${u}::uuid and privacy_epoch=${epoch} and recording_generation=${g} and explanation_unit_id=${m.explanationUnitId} and exposure_id<>${id}::uuid and first_eligible_activation_at<=${at} order by first_eligible_activation_at desc,exposure_id limit 1`.execute(
          db,
        );
        const returned =
          offer.mode === 'return' &&
          prior.rows[0] !== undefined &&
          at.getTime() - new Date(prior.rows[0].first_eligible_activation_at).getTime() >= 30 * 60000;
        if (returned)
          await sql`update experience.recording_segment_inputs set returned=true,navigation_revision=navigation_revision+1 where universe_id=${u}::uuid and exposure_id=${id}::uuid and recording_generation=${g} and not returned`.execute(
            db,
          );
        if (returned) await effects.enqueueActivity(scope, id);
        if (offer.source && (offer.mode === 'series' || offer.mode === 'related')) {
          const changed = await sql<{
            exposure_id: string;
          }>`update experience.recording_segment_inputs i set horizontal=true,navigation_revision=navigation_revision+1 where universe_id=${u}::uuid and privacy_epoch=${epoch} and exposure_id=${offer.source}::uuid and recording_generation=${g} and not horizontal and exists(select 1 from experience.recording_segments s where s.universe_id=i.universe_id and s.exposure_id=i.exposure_id and s.recording_generation=i.recording_generation and s.first_eligible_activation_at is not null) returning exposure_id`.execute(
            db,
          );
          if (changed.rows.length) await effects.enqueueActivity(scope, offer.source);
        }
      }
    },
  };
}

/** No historical initialization. The actual fresh lifecycle may certify EMPTY under a real
 * eligible action; only a genuine decision moves credit. Necessary flags never prove lineage. */
export async function applyRecordingChannel(
  scope: RecordingScopeTx,
  a: ChannelAction,
  necessaryChanged: boolean,
  effects: ExperienceRecordingEffects,
  lifecycle: ReadRecordingLifecycle,
): Promise<RecordingChannelsResult> {
  recordingTransactionOf(scope);
  const channel =
    a.kind === 'save' || a.kind === 'unsave' ? 'saved' : a.kind === 'like' || a.kind === 'unlike' ? 'liked' : undefined;
  if (!channel) return { changed: false };
  const positive = a.kind === 'save' || a.kind === 'like';
  const db = recordingTransactionOf(scope),
    u = scope.personal.authority.universeId,
    epoch = scope.personal.authority.privacyEpoch;
  const r = await sql<{
    state: boolean | null;
    origin_exposure: string | null;
    origin_action: string | null;
    revision: number;
  }>`select ${sql.ref(`recording_${channel}_state`)} as state,${sql.ref(`recording_${channel}_origin_exposure_id`)} as origin_exposure,${sql.ref(`recording_${channel}_origin_action_id`)} as origin_action,recording_channel_revision as revision from experience.action_state where universe_id=${u}::uuid and privacy_epoch=${epoch} and asset_id=${a.assetId}::uuid`.execute(
    db,
  );
  const old = r.rows[0];
  if (!old) throw new Error('RECORDING_CHANNEL_STATE_MISSING');
  if (
    !(await initializeChannelCertificate(
      scope,
      { assetId: a.assetId, channel, actionId: a.actionId, at: a.at },
      lifecycle,
    ))
  )
    return { changed: false };
  const certificate = await recordingChannelSelection(lifecycle)(scope, { assetId: a.assetId, channel });
  if (certificate.kind !== 'tracked' && certificate.kind !== 'certified_empty')
    throw new Error('RECORDING_CHANNEL_CERTIFICATE_UNAVAILABLE');
  if (certificate.kind === 'certified_empty' && old.state !== null) throw new Error('RECORDING_CHANNEL_EMPTY_MISMATCH');
  if (certificate.kind === 'tracked' && old.state === null) throw new Error('RECORDING_CHANNEL_TRACKED_MISMATCH');
  // A real eligible positive no-op may certify EMPTY metadata, never a false/positive decision.
  if (positive && !necessaryChanged) return { changed: false };
  if (!positive && old.state === false) return { changed: false };
  if (old.revision >= 2_147_483_647) throw new Error('RECORDING_CHANNEL_REVISION_EXHAUSTED');
  const changes: { exposureId: string; value: boolean; originActionId: string; originGeneration: number }[] = [];
  if (old.origin_exposure || old.origin_action) {
    if (!old.origin_exposure || !old.origin_action) throw new Error('RECORDING_ORIGIN_PAIR');
    const original = await sql<{
      eligible_generation: number | null;
      exposure_id: string;
      asset_id: string;
      kind: string;
    }>`select o.eligible_generation,l.credited_exposure_id as exposure_id,x.asset_id,a.kind from experience.actions a join experience.recording_command_origins o on o.universe_id=a.universe_id and o.command_id=a.command_id and o.privacy_epoch=a.privacy_epoch join experience.action_links l on l.universe_id=a.universe_id and l.action_id=a.id join experience.exposures x on x.universe_id=a.universe_id and x.id=l.credited_exposure_id and x.privacy_epoch=a.privacy_epoch where a.universe_id=${u}::uuid and a.privacy_epoch=${epoch} and a.id=${old.origin_action}::uuid`.execute(
      db,
    );
    const source = original.rows[0];
    if (
      !source?.eligible_generation ||
      source.exposure_id !== old.origin_exposure ||
      source.asset_id.toLowerCase() !== a.assetId.toLowerCase() ||
      source.kind !== (channel === 'saved' ? 'save' : 'like')
    )
      throw new Error('RECORDING_ORIGIN_LINEAGE');
    changes.push({
      exposureId: old.origin_exposure,
      value: false,
      originActionId: old.origin_action,
      originGeneration: source.eligible_generation,
    });
  }
  if (positive && a.exposureId) {
    const x = await readExposure(scope.personal, a.exposureId);
    if (
      !x?.activatedAt ||
      x.privacyEpoch !== epoch ||
      x.assetId.toLowerCase() !== a.assetId.toLowerCase() ||
      x.assetRevision !== a.assetRevision
    )
      throw new Error('RECORDING_TARGET_LINEAGE');
    changes.push({
      exposureId: x.id,
      value: true,
      originActionId: a.actionId,
      originGeneration: scope.generation,
    });
  }
  // Ensure exact source descriptor/overrides before the required owning aggregate effect.
  for (const c of changes) {
    if (c.originGeneration !== scope.generation)
      await sql`insert into experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation,asset_id,asset_revision,kind,explanation_unit_id,attribution_sha256,attribution_payload,initialized_at)
      select universe_id,privacy_epoch,exposure_id,${scope.generation},asset_id,asset_revision,kind,explanation_unit_id,attribution_sha256,attribution_payload,${a.at} from experience.recording_segments where universe_id=${u}::uuid and exposure_id=${c.exposureId}::uuid and recording_generation=${c.originGeneration} on conflict do nothing`.execute(
        db,
      );
    if (c.value)
      await sql`insert into experience.recording_segments(universe_id,privacy_epoch,exposure_id,recording_generation,asset_id,asset_revision,kind,explanation_unit_id,attribution_sha256,attribution_payload,initialized_at)
      select universe_id,privacy_epoch,exposure_id,${scope.generation},asset_id,asset_revision,kind,explanation_unit_id,attribution_sha256,attribution_payload,${a.at} from experience.recording_segments where universe_id=${u}::uuid and privacy_epoch=${epoch} and exposure_id=${c.exposureId}::uuid and recording_generation<${scope.generation} order by recording_generation desc limit 1 on conflict do nothing`.execute(
        db,
      );
    const present = await sql<{
      exposure_id: string;
    }>`select exposure_id from experience.recording_segments where universe_id=${u}::uuid and privacy_epoch=${epoch} and exposure_id=${c.exposureId}::uuid and recording_generation=${scope.generation}`.execute(
      db,
    );
    if (!present.rows.length) throw new Error('RECORDING_SEGMENT_SOURCE_MISSING');
    await sql`insert into experience.recording_segment_inputs(universe_id,privacy_epoch,exposure_id,recording_generation) values(${u}::uuid,${epoch},${c.exposureId}::uuid,${scope.generation}) on conflict do nothing`.execute(
      db,
    );
    await sql`update experience.recording_segment_inputs set ${sql.ref(`${channel}_override`)}=${c.value},${sql.ref(`${channel}_decision_action_id`)}=${a.actionId}::uuid,${sql.ref(`${channel}_origin_action_id`)}=${c.originActionId}::uuid,${sql.ref(`${channel}_origin_generation`)}=${c.originGeneration},action_revision=action_revision+1 where universe_id=${u}::uuid and exposure_id=${c.exposureId}::uuid and recording_generation=${scope.generation} and privacy_epoch=${epoch}`.execute(
      db,
    );
  }
  // Same exposure transfer is one final true override, not two independent aggregate effects.
  const final = [...new Map(changes.map((c) => [c.exposureId, c])).values()];
  const pointer =
    await sql`update experience.action_state set ${sql.ref(`recording_${channel}_state`)}=${positive},${sql.ref(`recording_${channel}_origin_exposure_id`)}=${positive ? (a.exposureId ?? null) : null}::uuid,${sql.ref(`recording_${channel}_origin_action_id`)}=${positive && a.exposureId ? a.actionId : null}::uuid,${sql.ref(`recording_${channel}_decision_action_id`)}=${a.actionId}::uuid,recording_channel_revision=recording_channel_revision+1 where universe_id=${u}::uuid and privacy_epoch=${epoch} and asset_id=${a.assetId}::uuid and recording_channel_revision=${old.revision}`.execute(
      db,
    );
  if (pointer.numAffectedRows !== 1n) throw new Error('RECORDING_CHANNEL_CAS');
  await certifyFirstDecision(scope, { assetId: a.assetId, channel, actionId: a.actionId });
  const changed =
    final.length > 0
      ? await effects.applyChannels(scope, {
          commandId: a.commandId,
          actionId: a.actionId,
          assetId: a.assetId,
          channel,
          pointerRevision: old.revision + 1,
          changes: final,
        })
      : { changed: false as const };
  if (typeof changed !== 'object' || changed === null || (changed.changed !== false && changed.changed !== true))
    throw new Error('RECORDING_EFFECT_RESULT_INVALID');
  const root = await db
    .selectFrom('identity.universes')
    .select('revision')
    .where('id', '=', u)
    .executeTakeFirstOrThrow();
  if (
    changed.changed
      ? !Number.isInteger(changed.revision) ||
        changed.revision !== scope.personal.revisionAtEntry + 1 ||
        root.revision !== changed.revision
      : root.revision !== scope.personal.revisionAtEntry
  )
    throw new Error('RECORDING_EFFECT_REVISION_INVALID');
  return changed;
}

export function requireRecordingEffects(value: ExperienceRecordingEffects | undefined): ExperienceRecordingEffects {
  if (
    !value ||
    typeof value.applyChannels !== 'function' ||
    typeof value.startSession !== 'function' ||
    typeof value.enqueueActivity !== 'function' ||
    typeof value.enqueueActionEvidence !== 'function'
  )
    throw new Error('EXPERIENCE_RECORDING_EFFECTS_REQUIRED');
  return value;
}

const StoredAttributionSchema = z.strictObject({
  explanationUnitId: z.string().min(1).max(160),
  topics: z
    .array(
      z.strictObject({
        topicId: z.string().min(1).max(160),
        role: z.enum(['primary', 'supporting', 'incidental']),
        weight: z.number().finite().nonnegative(),
      }),
    )
    .max(16),
  facets: z.array(z.string().min(1).max(160)).max(16),
  catalogWatermark: z.string().min(1),
  attributionVersion: z.string().min(1),
});
export const readRecordingSegment: ReadRecordingSegment = async (scope, id) => {
  const p = scope.personal,
    db = recordingTransactionOf(scope);
  const result = await sql<{
    exposure_id: string;
    asset_id: string;
    asset_revision: number;
    kind: 'reel' | 'scroll';
    explanation_unit_id: string;
    attribution_sha256: string;
    attribution_payload: unknown;
    initialized_at: Date;
    first_eligible_activation_at: Date | null;
    activated_at: Date;
    saved_override: boolean | null;
    liked_override: boolean | null;
    horizontal: boolean;
    returned: boolean;
    action_revision: number;
    navigation_revision: number;
    saved_decision_action_id: string | null;
    liked_decision_action_id: string | null;
    saved_origin_action_id: string | null;
    liked_origin_action_id: string | null;
    saved_origin_generation: number | null;
    liked_origin_generation: number | null;
  }>`select s.*,x.activated_at,i.saved_override,i.liked_override,i.horizontal,i.returned,i.action_revision,i.navigation_revision,i.saved_decision_action_id,i.liked_decision_action_id,i.saved_origin_action_id,i.liked_origin_action_id,i.saved_origin_generation,i.liked_origin_generation from experience.recording_segments s join experience.recording_segment_inputs i on i.universe_id=s.universe_id and i.exposure_id=s.exposure_id and i.recording_generation=s.recording_generation and i.privacy_epoch=s.privacy_epoch join experience.exposures x on x.universe_id=s.universe_id and x.id=s.exposure_id and x.privacy_epoch=s.privacy_epoch where s.universe_id=${p.authority.universeId}::uuid and s.privacy_epoch=${p.authority.privacyEpoch} and s.exposure_id=${id}::uuid and s.recording_generation=${scope.generation} and x.activated_at is not null`.execute(
    db,
  );
  const r = result.rows[0];
  if (!r) return undefined;
  const metadata = StoredAttributionSchema.parse(r.attribution_payload);
  if (
    metadata.explanationUnitId !== r.explanation_unit_id ||
    requestHash('experience.recording-attribution', metadata) !== r.attribution_sha256
  )
    throw new Error('RECORDING_ATTRIBUTION_INVALID');
  const override = (channel: 'saved' | 'liked') =>
    r[`${channel}_override`] === null
      ? null
      : {
          value: r[`${channel}_override`]!,
          decisionActionId: r[`${channel}_decision_action_id`]!,
          originActionId: r[`${channel}_origin_action_id`]!,
          originGeneration: r[`${channel}_origin_generation`]!,
        };
  return {
    recordingGeneration: scope.generation,
    exposure: {
      exposureId: r.exposure_id,
      assetId: r.asset_id,
      assetRevision: r.asset_revision,
      kind: r.kind,
      activatedAt: new Date(r.activated_at).toISOString(),
      explanationUnitId: r.explanation_unit_id,
    },
    metadata,
    attributionSha256: r.attribution_sha256,
    initializedAt: new Date(r.initialized_at).toISOString(),
    ...(r.first_eligible_activation_at
      ? { firstEligibleActivationAt: new Date(r.first_eligible_activation_at).toISOString() }
      : {}),
    likedOverride: r.liked_override,
    savedOverride: r.saved_override,
    likedDecision: override('liked'),
    savedDecision: override('saved'),
    channelRevision: r.action_revision,
    horizontal: r.horizontal,
    returned: r.returned,
    navigationRevision: r.navigation_revision,
  };
};
