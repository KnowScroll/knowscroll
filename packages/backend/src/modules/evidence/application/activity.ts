import type { ActivityProjectionResult } from './activity-contracts.js';
import type { ActivityDerivedEffect } from './context-ports.js';
import type { PreparedEvidenceInput } from '../../composer/public.js';
import { z } from 'zod';
import { activity, ACTIVITY_POLICY, type ActivityChannels } from '../domain/activity.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { ReadEncounterAttribution, EncounterAttribution } from '../../content/public.js';
import type {
  ReadActivityLineage,
  ReadExposureForEvidence,
  EnsureActivityLineage,
  ReadRoutingHistory,
  ReadActivityReconcilePage,
  ActivityLineage,
} from '../../experience/public.js';
import type { ReadPreparedEvidenceInput } from '../../composer/public.js';
import type { ProjectScrollReadingPayload } from '../events.js';
export interface QualificationInput {
  readonly revision: number;
  readonly qualification: 'qualified' | 'not_qualified' | 'unknown';
  readonly q: number;
  readonly assetId: string;
  readonly assetRevision: number;
}
export interface ActivityProjection {
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
  /** Required by shipped composition once personal context is installed; isolated fixtures may omit it. */
  readonly derived?: ActivityDerivedEffect;
  readonly materialChange?: (scope: PersonalScopeTx, input: { readonly sourceRevision: number }) => Promise<void>;
  readonly withPersonalScope: WithPersonalScope;
  readonly readExposure: ReadExposureForEvidence;
  readonly readLineage: ReadActivityLineage;
  readonly ensureLineage: EnsureActivityLineage;
  readonly readAttribution: ReadEncounterAttribution;
  readonly readHistory: ReadRoutingHistory;
  readonly readReconcilePage: ReadActivityReconcilePage;
  readonly readQualification: (scope: PersonalScopeTx, id: string) => Promise<QualificationInput | undefined>;
  readonly currentActivity: (
    scope: PersonalScopeTx,
    id: string,
  ) => Promise<{ readonly inputHash: string; readonly activityId: string } | undefined>;
  readonly persist: (scope: PersonalScopeTx, projection: ActivityProjection) => Promise<void>;
  readonly readTopicContext: (
    scope: PersonalScopeTx,
    topicIds: readonly string[],
    evaluatedAt: string,
  ) => Promise<PreparedEvidenceInput['topics']>;
  readonly pending: (scope: PersonalScopeTx, id: string) => Promise<boolean>;
  readonly enqueue: (scope: PersonalScopeTx, id: string) => Promise<void>;
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
  scope: PersonalScopeTx,
  id: string,
  evaluatedAt: string,
): Promise<ActivityProjection | undefined> {
  const exposure = await p.readExposure(scope, id);
  if (!exposure?.activatedAt || exposure.privacyEpoch !== scope.authority.privacyEpoch) return undefined;
  const metadata = await p.readAttribution(scope, { assetId: exposure.assetId, assetRevision: exposure.assetRevision });
  if (!metadata) return undefined;
  await p.ensureLineage(scope, id, metadata);
  const lineage = await p.readLineage(scope, id);
  if (!lineage) return undefined;
  const q = await p.readQualification(scope, id);
  if (q && (q.assetId !== lineage.assetId || q.assetRevision !== lineage.assetRevision))
    throw new Error('ACTIVITY_QUALIFICATION_LINEAGE_INVALID');
  const vector = {
    qualificationRevision: q?.revision ?? 0,
    actionRevision: lineage.actionRevision,
    navigationRevision: lineage.navigationRevision,
    attribution: metadata.catalogWatermark,
    policy: ACTIVITY_POLICY.version,
  };
  const channels: ActivityChannels = {
    q: q && q.qualification !== 'unknown' ? q.q : null,
    L: lineage.liked,
    B: lineage.saved,
    S: 0,
    H: lineage.horizontal,
    R: lineage.returned,
  };
  return {
    id: p.newId(),
    exposure: lineage,
    metadata,
    inputHash: p.hash(vector),
    inputVector: vector,
    channels,
    value: activity(channels),
    measured: q !== undefined && q.qualification !== 'unknown',
    qualified: q?.qualification === 'qualified',
    evaluatedAt,
  };
}
export function makeProjectEncounterActivity(p: ActivityPorts) {
  return async (payload: ProjectScrollReadingPayload): Promise<ActivityProjectionResult> => {
    const entered = await p.withPersonalScope(
      {
        universeId: payload.universeId,
        privacyEpoch: payload.privacyEpoch,
        actor: { kind: 'system', purpose: 'evidence.project-encounter-activity' },
      },
      async (scope): Promise<ActivityProjectionResult> => {
        const x = await inputs(p, scope, payload.exposureId, p.now().toISOString());
        if (!x) return { kind: 'skipped', reason: 'metadata_missing' };
        const current = await p.currentActivity(scope, payload.exposureId);
        const activityChanged = current?.inputHash !== x.inputHash;
        if (activityChanged) await p.persist(scope, x);
        const derivedChanged = (await p.derived?.apply(scope, x)) ?? false;
        if (!activityChanged && !derivedChanged) return { kind: 'skipped', reason: 'already_applied' };
        const revision = await p.advance(scope);
        await p.materialChange?.(scope, { sourceRevision: revision });
        const activityId = activityChanged ? x.id : current.activityId;
        await p.notify(scope, { revision, eventId: activityId });
        return { kind: 'applied', activityId, revision };
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
  return async (authority: PersonalAuthority, query: { readonly after?: string; readonly limit: number }) => {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 100 ||
      (query.after !== undefined && !z.uuid().safeParse(query.after).success)
    )
      throw new Error('ACTIVITY_RECONCILE_QUERY_INVALID');
    return p.withPersonalScope(authority, async (scope) => {
      const ids = await p.readReconcilePage(scope, query);
      let queued = 0;
      let gaps = 0;
      let pending = 0;
      for (const id of ids) {
        const x = await inputs(p, scope, id, p.now().toISOString());
        if (!x) {
          gaps++;
          continue;
        }
        if (
          (await p.currentActivity(scope, id))?.inputHash === x.inputHash &&
          (!p.derived || (await p.derived.isCurrent(scope, x)))
        )
          continue;
        if (await p.pending(scope, id)) {
          pending++;
          continue;
        }
        await p.enqueue(scope, id);
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
