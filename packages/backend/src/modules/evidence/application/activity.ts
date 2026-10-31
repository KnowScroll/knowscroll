import type { PrepareObservedCoverage } from './coverage-ports.js';
import type { ObservedCoverage } from '../domain/coverage.js';
import type { ActivityProjectionResult } from './activity-contracts.js';
import type { ActivityDerivedEffect, RecordingActivityDerivedInput } from './context-ports.js';
import type { PreparedEvidenceInput } from '../../composer/public.js';
import { z } from 'zod';
import {
  activity,
  ACTIVITY_POLICY,
  continuationCredit,
  type ActivityChannels,
  type ActivityPolicyVersion,
} from '../domain/activity.js';
import type {
  PersonalAuthority,
  PersonalScopeTx,
  RecordingScopeTx,
  WithPersonalScope,
  FenceOwnAccount,
  FencePersonalRecording,
  ReadRecordingLifecycle,
} from '../../identity/public.js';
import type { ReadEncounterAttribution, EncounterAttribution, ReadPlayLevel, PlayLevel } from '../../content/public.js';
import type {
  ReadActivityLineage,
  ReadExposureForEvidence,
  EnsureActivityLineage,
  ReadRoutingHistory,
  ReadActivityReconcilePage,
  ActivityLineage,
  ReadRecordingSegment,
  ReadRecordingChannelSelection,
} from '../../experience/public.js';
import type { ReadPreparedEvidenceInput } from '../../composer/public.js';
import { ProjectScrollReadingPayloadSchema, type ProjectScrollReadingPayload } from '../events.js';
import { recordingCredit, emptyRecordingCredit, type RecordingCredit } from '../domain/recording-credit.js';
export interface QualificationInput {
  readonly id: string;
  readonly recordingGeneration: number;
  readonly revision: number;
  readonly qualification: 'qualified' | 'not_qualified' | 'unknown';
  readonly q: number;
  /** How much of the encounter was seen, in [0, 1]: the bar a deliberate continuation must clear (activity.v1). */
  readonly coverage: number;
  readonly assetId: string;
  readonly assetRevision: number;
}
export interface ActivityProjection {
  /** The activity rule this revision was computed under, stored with it. */
  readonly policyVersion: ActivityPolicyVersion;
  /** How much the Scroll asked of the reader, read from the stored revision; plain for a Reel (D-192). */
  readonly playLevel: PlayLevel;
  readonly recordingGeneration: number;
  readonly segmentChannels: ActivityChannels;
  readonly clockDomain: 'legacy' | 'session';
  readonly base: RecordingCredit;
  readonly effective: RecordingCredit;
  readonly attributionSha256: string;
  readonly currentSegment: {
    readonly measured: boolean;
    readonly qualified: boolean;
    readonly qualification: RecordingActivityDerivedInput['currentSegment']['qualification'];
  };
  readonly coverage?: ObservedCoverage;
  readonly id: string;
  readonly exposure: ActivityLineage;
  readonly metadata: EncounterAttribution;
  readonly inputHash: string;
  readonly inputVector: Readonly<Record<string, string | number>>;
  readonly channels: ActivityChannels;
  readonly value: number;
  readonly measured: boolean;
  readonly qualified: boolean;
  readonly evaluatedAt: string;
}
export interface ActivityPorts {
  readonly prepareCoverage?: PrepareObservedCoverage;
  /** Required by shipped composition once personal context is installed; isolated fixtures may omit it. */
  readonly derived?: ActivityDerivedEffect;
  readonly materialChange?: (
    scope: RecordingScopeTx,
    input: { readonly sourceRevision: number; readonly recordingGeneration: number },
  ) => Promise<void>;
  readonly withPersonalScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly fenceRecording: FencePersonalRecording;
  readonly readLifecycle: ReadRecordingLifecycle;
  readonly readSegment: ReadRecordingSegment;
  readonly readChannelSelection: ReadRecordingChannelSelection;
  readonly readCredit: (
    scope: RecordingScopeTx,
    id: string,
  ) => Promise<
    | {
        readonly generation: number;
        readonly attributionSha256: string;
        readonly base: RecordingCredit;
        readonly effective: RecordingCredit;
        readonly inputHash: string;
      }
    | undefined
  >;
  readonly legacyCredit: (
    scope: RecordingScopeTx,
    id: string,
    metadata: EncounterAttribution,
  ) => Promise<RecordingCredit>;
  readonly readExposure: ReadExposureForEvidence;
  readonly readLineage: ReadActivityLineage;
  readonly ensureLineage: EnsureActivityLineage;
  readonly readAttribution: ReadEncounterAttribution;
  readonly readPlayLevel: ReadPlayLevel;
  readonly readHistory: ReadRoutingHistory;
  readonly readReconcilePage: ReadActivityReconcilePage;
  readonly readQualification: (
    scope: RecordingScopeTx,
    id: string,
    domain: 'legacy' | 'session',
    initializedAt: string,
  ) => Promise<QualificationInput | undefined>;
  readonly currentActivity: (
    scope: RecordingScopeTx,
    id: string,
  ) => Promise<{ readonly inputHash: string; readonly activityId: string; readonly revision: number } | undefined>;
  readonly persist: (scope: RecordingScopeTx, projection: ActivityProjection) => Promise<void>;
  readonly readTopicContext: (
    scope: PersonalScopeTx,
    topicIds: readonly string[],
    evaluatedAt: string,
  ) => Promise<PreparedEvidenceInput['topics']>;
  readonly pending: (scope: RecordingScopeTx, id: string) => Promise<boolean>;
  readonly enqueue: (scope: RecordingScopeTx, id: string) => Promise<void>;
  readonly advance: (scope: PersonalScopeTx) => Promise<number>;
  readonly notify: (
    scope: PersonalScopeTx,
    change: { readonly revision: number; readonly eventId: string },
  ) => Promise<void>;
  readonly hash: (input: Readonly<Record<string, string | number>>) => string;
  readonly newId: () => string;
  readonly now: () => Date;
}
async function inputs(
  p: ActivityPorts,
  cap: RecordingScopeTx,
  id: string,
  evaluatedAt: string,
  domain: 'legacy' | 'session',
): Promise<ActivityProjection | { readonly kind: 'no_current_source' } | undefined> {
  const lifecycle = await p.readLifecycle(cap);
  if (lifecycle.kind === 'unavailable') throw new Error('RECORDING_LIFECYCLE_UNAVAILABLE');
  if (lifecycle.kind === 'not_ready') return { kind: 'no_current_source' };
  const segment = await p.readSegment(cap, id);
  if (!segment || segment.recordingGeneration !== cap.generation) return undefined;
  const legacyQ =
    cap.generation === 1 && segment.firstEligibleActivationAt
      ? await p.readQualification(cap, id, 'legacy', segment.initializedAt)
      : undefined;
  const sessionQ = segment.firstEligibleActivationAt
    ? await p.readQualification(cap, id, 'session', segment.initializedAt)
    : undefined;
  for (const q of [legacyQ, sessionQ])
    if (
      q &&
      (q.recordingGeneration !== cap.generation ||
        q.assetId !== segment.exposure.assetId ||
        q.assetRevision !== segment.exposure.assetRevision)
    )
      throw new Error('ACTIVITY_QUALIFICATION_LINEAGE_INVALID');
  // A descriptor/session is authority to receive evidence, not evidence itself. In particular,
  // an explicit false decision is a real correction source; NULL without a decision is not.
  if (
    !legacyQ &&
    !sessionQ &&
    !(segment.savedOverride !== null && segment.savedDecision !== null) &&
    !(segment.likedOverride !== null && segment.likedDecision !== null) &&
    !segment.horizontal &&
    !segment.returned
  )
    return { kind: 'no_current_source' };
  const prior = await p.readCredit(cap, id);
  if (prior && prior.attributionSha256 !== segment.attributionSha256) throw new Error('ACTIVITY_ATTRIBUTION_CHANGED');
  if (prior && prior.generation > cap.generation) throw new Error('ACTIVITY_GENERATION_REGRESSION');
  const base = prior
    ? prior.generation === cap.generation
      ? prior.base
      : prior.effective
    : await p.legacyCredit(cap, id, segment.metadata);
  // A deliberate continuation credits the exposure it left only when that exposure was read enough to
  // count (activity.v1); with no measured reading there is nothing to clear the bar with.
  const continued = (q: QualificationInput | undefined) =>
    continuationCredit(ACTIVITY_POLICY, { horizontal: segment.horizontal, coverage: q?.coverage ?? null });
  const source = (q: QualificationInput | undefined) => ({
    channels: {
      q: q && q.qualification !== 'unknown' ? q.q : null,
      L: false,
      B: false,
      S: 0 as const,
      H: continued(q),
      R: segment.returned,
    },
    measured: q !== undefined && q.qualification !== 'unknown',
    qualified: q?.qualification === 'qualified',
    qualification: q ? { id: q.id, recordingGeneration: q.recordingGeneration, revision: q.revision } : null,
  });
  const effective = recordingCredit({
    base,
    previous: recordingCredit({
      base,
      previous: emptyRecordingCredit(),
      domain: 'legacy',
      source: source(legacyQ),
      likedOverride: segment.likedOverride,
      savedOverride: segment.savedOverride,
    }),
    domain: 'session',
    source: source(sessionQ),
    likedOverride: segment.likedOverride,
    savedOverride: segment.savedOverride,
  });
  // L/B selection is owned by Experience, not current necessary flags or Content metadata.
  // Two exact channel probes; legacy unknown may retain its COMMITTED base, never add credit.
  for (const [channel, key] of [
    ['saved', 'B'],
    ['liked', 'L'],
  ] as const) {
    if (!effective.channels[key]) continue;
    const selected = await p.readChannelSelection(cap, { assetId: segment.exposure.assetId, channel });
    if (
      selected.kind === 'legacy_unknown' &&
      base.channels[key] &&
      (key === 'B' ? segment.savedOverride : segment.likedOverride) !== true
    )
      continue;
    if (selected.kind !== 'tracked' || !selected.state || selected.originExposureId?.toLowerCase() !== id.toLowerCase())
      throw new Error('RECORDING_CHANNEL_SELECTION_UNAVAILABLE');
    const decision = channel === 'saved' ? segment.savedDecision : segment.likedDecision;
    if (decision?.value && selected.originActionId?.toLowerCase() !== decision.originActionId.toLowerCase())
      throw new Error('RECORDING_CHANNEL_SELECTED_ACTION_MISMATCH');
  }
  // Choose only a factual source from THIS generation; inherited effective qualification is excluded.
  const q =
    sessionQ?.qualification === 'qualified'
      ? sessionQ
      : legacyQ?.qualification === 'qualified'
        ? legacyQ
        : (sessionQ ?? legacyQ);
  const measured = q !== undefined && q.qualification !== 'unknown';
  const qualification = q ? { id: q.id, recordingGeneration: q.recordingGeneration, revision: q.revision } : null;
  const vector = {
    recordingGeneration: cap.generation,
    qualificationId: q?.id ?? '',
    qualificationRevision: q?.revision ?? 0,
    legacyQualificationId: legacyQ?.id ?? '',
    sessionQualificationId: sessionQ?.id ?? '',
    effective: p.hash({ credit: JSON.stringify(effective) }),
    actionRevision: segment.channelRevision,
    navigationRevision: segment.navigationRevision,
    attribution: segment.attributionSha256,
    policy: 'recording-credit.v1',
    activityPolicy: ACTIVITY_POLICY.version,
  };
  return {
    id: p.newId(),
    policyVersion: ACTIVITY_POLICY.version,
    playLevel: await p.readPlayLevel(cap.personal, segment.exposure),
    recordingGeneration: cap.generation,
    segmentChannels: {
      q: measured ? q.q : null,
      L: segment.likedOverride ?? false,
      B: segment.savedOverride ?? false,
      S: 0,
      H: continued(q),
      R: segment.returned,
    },
    clockDomain: domain,
    base,
    effective,
    attributionSha256: segment.attributionSha256,
    currentSegment: { measured, qualified: q?.qualification === 'qualified', qualification },
    exposure: {
      ...segment.exposure,
      facets: segment.metadata.facets,
      saved: effective.channels.B,
      liked: effective.channels.L,
      horizontal: effective.channels.H,
      returned: effective.channels.R,
      actionRevision: segment.channelRevision,
      navigationRevision: segment.navigationRevision,
    },
    metadata: segment.metadata,
    inputHash: p.hash(vector),
    inputVector: vector,
    channels: effective.channels,
    value: activity(effective.channels),
    measured: effective.measured,
    qualified: effective.qualified,
    evaluatedAt,
    ...(p.prepareCoverage && q
      ? {
          coverage: await p.prepareCoverage(cap.personal, {
            ...segment.exposure,
            recordingGeneration: cap.generation,
            ...(q ? { qualificationId: q.id } : {}),
          }),
        }
      : {}),
  };
}
function recordingDerived(x: ActivityProjection, activityId: string, revision: number): RecordingActivityDerivedInput {
  return {
    version: 'recording-activity.v1',
    recordingGeneration: x.recordingGeneration,
    exposure: x.exposure,
    metadata: x.metadata,
    inputVector: x.inputVector,
    currentSegment: {
      ...x.currentSegment,
      activity: { id: activityId, recordingGeneration: x.recordingGeneration, revision },
      ...(x.coverage ? { coverage: x.coverage } : {}),
    },
    evidenceEffective: { channels: x.channels, measured: x.measured, qualified: x.qualified },
  };
}
/** Required real derived owner: omission must roll the transaction back, never fake growth. */
function recordingEffects(p: ActivityPorts): ActivityDerivedEffect {
  if (
    !p.derived ||
    typeof p.derived.applyRecording !== 'function' ||
    typeof p.derived.isRecordingCurrent !== 'function' ||
    !p.materialChange
  )
    throw new Error('RECORDING_DERIVED_EFFECTS_REQUIRED');
  return p.derived;
}
export async function applyRecordingActivity(
  p: ActivityPorts,
  cap: RecordingScopeTx,
  id: string,
  domain: 'legacy' | 'session',
  evaluatedAt: string,
) {
  const x = await inputs(p, cap, id, evaluatedAt, domain);
  if (!x || 'kind' in x) return x;
  const derived = recordingEffects(p);
  const current = await p.currentActivity(cap, id);
  const activityChanged = current?.inputHash !== x.inputHash;
  if (activityChanged) await p.persist(cap, x);
  const committed = activityChanged ? await p.currentActivity(cap, id) : current;
  if (!committed) throw new Error('RECORDING_ACTIVITY_HEAD_MISSING');
  const derivedChanged = await derived.applyRecording(
    cap,
    recordingDerived(x, committed.activityId, committed.revision),
  );
  return { changed: activityChanged || derivedChanged, activityId: committed.activityId };
}
export function makeProjectEncounterActivity(p: ActivityPorts) {
  return async (payload: ProjectScrollReadingPayload): Promise<ActivityProjectionResult> => {
    payload = ProjectScrollReadingPayloadSchema.parse(payload);
    const entered = await p.withPersonalScope(
      {
        universeId: payload.universeId,
        privacyEpoch: payload.privacyEpoch,
        actor: { kind: 'system', purpose: 'evidence.project-encounter-activity' },
      },
      async (scope): Promise<ActivityProjectionResult> => {
        if ((await p.fenceOwn(scope)).kind !== 'active') return { kind: 'skipped', reason: 'universe_unavailable' };
        const gate = await p.fenceRecording(scope, payload.v === 2 ? payload.recordingGeneration : undefined);
        if (gate.kind !== 'recording') return { kind: 'skipped', reason: 'recording_ineligible' };
        const x = await applyRecordingActivity(
          p,
          gate.scope,
          payload.exposureId,
          payload.v === 1 ? 'legacy' : 'session',
          p.now().toISOString(),
        );
        if (!x) return { kind: 'skipped', reason: 'metadata_missing' };
        if ('kind' in x) return { kind: 'skipped', reason: x.kind };
        if (!x.changed) return { kind: 'skipped', reason: 'already_applied' };
        const revision = await p.advance(scope);
        await p.materialChange!(gate.scope, { sourceRevision: revision, recordingGeneration: gate.scope.generation });
        await p.notify(scope, { revision, eventId: x.activityId });
        return { kind: 'applied', activityId: x.activityId, revision };
      },
    );
    return entered.kind === 'entered'
      ? entered.value
      : {
          kind: 'skipped',
          reason: entered.refusal.kind === 'epoch_changed' ? 'epoch_changed' : 'universe_unavailable',
        };
  };
}
const Id = z.string().min(1).max(160);
const PreparedQuery = z.strictObject({
  evaluatedAt: z.iso.datetime(),
  topicIds: z.array(Id).max(100),
  candidates: z.array(z.strictObject({ explanationUnitId: Id, facets: z.array(Id).max(16) })).max(100),
  candidateAssetIds: z.array(z.uuid()).max(100).optional(),
});
export function makeReadPreparedActivity(p: ActivityPorts): ReadPreparedEvidenceInput {
  return async (scope, query) => {
    const q = PreparedQuery.parse(query);
    if (
      new Set(q.topicIds).size !== q.topicIds.length ||
      new Set(q.candidates.map((c) => c.explanationUnitId)).size !== q.candidates.length ||
      q.candidates.some((c) => new Set(c.facets).size !== c.facets.length) ||
      new Set(q.candidateAssetIds).size !== (q.candidateAssetIds?.length ?? 0)
    )
      throw new Error('ACTIVITY_CONTEXT_QUERY_INVALID');
    const history = await p.readHistory(scope, {
      evaluatedAt: q.evaluatedAt,
      candidates: q.candidates,
      candidateAssetIds: q.candidateAssetIds ?? [],
    });
    const watermark = String(scope.revisionAtEntry);
    return {
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      evaluatedAt: q.evaluatedAt,
      watermark,
      policyVersion: ACTIVITY_POLICY.version,
      topics: await p.readTopicContext(scope, q.topicIds, q.evaluatedAt),
      recent: history.recent,
      hiddenAssetIds: history.hiddenAssetIds,
      established: { policyVersion: 'retained-activated-history.v0', watermark, units: history.established },
    };
  };
}
/** Explicit operator/rollout capability. One <=100 page; uses the SAME normal queue, no scheduler. */
export function makeReconcileEncounterActivity(p: ActivityPorts) {
  return async (
    authority: PersonalAuthority,
    query: { readonly after?: string; readonly limit: number; readonly recordingGeneration?: number },
  ) => {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100 ||
      (query.after !== undefined && !z.uuid().safeParse(query.after).success)
    )
      throw new Error('ACTIVITY_RECONCILE_QUERY_INVALID');
    return p.withPersonalScope(authority, async (scope) => {
      if ((await p.fenceOwn(scope)).kind !== 'active') throw new Error('ACTIVITY_ACCOUNT_UNAVAILABLE');
      const gate = await p.fenceRecording(scope, query.recordingGeneration);
      if (gate.kind !== 'recording')
        return {
          examined: 0,
          queued: 0,
          pending: 0,
          metadataGaps: 0,
          watermark: scope.revisionAtEntry,
          pageComplete: true,
        };
      const cap = gate.scope;
      const ids = await p.readReconcilePage(scope, query);
      let queued = 0;
      let gaps = 0;
      let pending = 0;
      for (const id of ids) {
        const x = await inputs(p, cap, id, p.now().toISOString(), 'session');
        if (!x) {
          gaps++;
          continue;
        }
        if ('kind' in x) continue;
        const current = await p.currentActivity(cap, id);
        if (
          current?.inputHash === x.inputHash &&
          (await recordingEffects(p).isRecordingCurrent(cap, recordingDerived(x, current.activityId, current.revision)))
        )
          continue;
        if (await p.pending(cap, id)) {
          pending++;
          continue;
        }
        await p.enqueue(cap, id);
        queued++;
      }
      return {
        examined: ids.length,
        queued,
        pending,
        metadataGaps: gaps,
        watermark: scope.revisionAtEntry,
        pageComplete: ids.length < query.limit,
        ...(ids.length === query.limit ? { nextCursor: ids.at(-1)! } : {}),
      };
    });
  };
}
