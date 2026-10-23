import { sql } from 'kysely';
import { canonicalJson, canonicalSha256, utf8ByteLength } from '@knowscroll/scroll-model';
import type { RecordingScopeTx } from '../../identity/public.js';
import type { RecordingActivityDerivedInput } from '../../evidence/public.js';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import {
  CONTEXT_POLICY,
  ContributionSchema,
  RecordingContributionEnvelopeSchema,
  recordingContribution,
  type Contribution,
} from '../domain/context.js';
import type { CoverageDependencies } from '../application/coverage-ports.js';
import { replaceStructuralSupports, advanceContextState } from './postgres-store.js';
import { applyRecordingCoverage, recordingCoverageCurrent } from './coverage-store.js';

const envelope = (contribution: Contribution | null) => ({
  version: 'recording-personal-contribution.v1' as const,
  contribution,
});
function currentContribution(scope: RecordingScopeTx, x: RecordingActivityDerivedInput): Contribution {
  recordingTransactionOf(scope); // Reject structural/counterfeit capabilities before any interpretation.
  const s = x.currentSegment,
    g = scope.generation;
  if (
    x.version !== 'recording-activity.v1' ||
    x.recordingGeneration !== g ||
    s.activity.recordingGeneration !== g ||
    (s.qualification && s.qualification.recordingGeneration !== g) ||
    (s.qualified && (!s.qualification || !s.measured))
  )
    throw new Error('PERSONAL_CONTEXT_RECORDING_SOURCE');
  return ContributionSchema.parse({
    version: 'personal-contribution.v0',
    exposureId: x.exposure.exposureId,
    assetId: x.exposure.assetId,
    assetRevision: x.exposure.assetRevision,
    activatedAt: x.exposure.activatedAt,
    explanationUnitId: x.metadata.explanationUnitId,
    qualified: s.qualified && s.qualification !== null,
    coveredFacets: [],
    topics: x.metadata.topics.filter((t) => t.weight > 0).map(({ topicId, role }) => ({ topicId, role })),
    input: {
      qualificationRevision: s.qualification?.revision ?? 0,
      actionRevision: x.inputVector.actionRevision,
      navigationRevision: x.inputVector.navigationRevision,
      attribution: x.inputVector.attribution,
      activityPolicy: x.inputVector.policy,
      projectionPolicy: CONTEXT_POLICY,
    },
  });
}
async function prepare(scope: RecordingScopeTx, x: RecordingActivityDerivedInput) {
  const current = currentContribution(scope, x),
    db = recordingTransactionOf(scope),
    u = scope.personal.authority.universeId,
    epoch = scope.personal.authority.privacyEpoch;
  const row = await sql<{ working_generation: number; frozen_base: unknown; payload: unknown; input_sha256: string }>`
    select working_generation,frozen_base,payload,input_sha256 from personal_context.recording_exposure_contributions
    where universe_id=${u}::uuid and privacy_epoch=${epoch} and exposure_id=${current.exposureId}::uuid`.execute(db);
  const old = row.rows[0];
  let previous: Contribution | null, base: Contribution | null;
  if (old) {
    if (old.working_generation > scope.generation) throw new Error('PERSONAL_CONTEXT_RECORDING_REGRESSION');
    previous = RecordingContributionEnvelopeSchema.parse(old.payload).contribution;
    base =
      old.working_generation === scope.generation
        ? RecordingContributionEnvelopeSchema.parse(old.frozen_base).contribution
        : previous;
  } else {
    const legacy = await sql<{
      payload: unknown;
      input_sha256: string;
    }>`select payload,input_sha256 from personal_context.contributions
      where universe_id=${u}::uuid and privacy_epoch=${epoch} and exposure_id=${current.exposureId}::uuid`.execute(db);
    previous = legacy.rows[0] ? ContributionSchema.parse(legacy.rows[0].payload) : null;
    if (previous && legacy.rows[0]?.input_sha256 !== requestHash(CONTEXT_POLICY, previous))
      throw new Error('PERSONAL_CONTEXT_STORED_INVALID');
    base = previous;
  }
  const next = recordingContribution(base, current),
    frozen = envelope(base),
    payload = envelope(next);
  const digest = canonicalSha256({
    version: 'recording-personal-input.v1',
    generation: scope.generation,
    frozen,
    current,
    activity: x.currentSegment.activity,
    qualification: x.currentSegment.qualification,
    coverage: x.currentSegment.coverage ?? null,
  });
  for (const value of [frozen, payload, current])
    if (utf8ByteLength(canonicalJson(value)) > 16384) throw new Error('PERSONAL_CONTEXT_RECORDING_LIMIT');
  return { current, previous, next, frozen, payload, digest, old };
}
export async function applyRecordingContext(
  scope: RecordingScopeTx,
  x: RecordingActivityDerivedInput,
  p: CoverageDependencies,
) {
  const v = await prepare(scope, x),
    db = recordingTransactionOf(scope),
    u = scope.personal.authority.universeId,
    epoch = scope.personal.authority.privacyEpoch;
  const structuralChanged = v.old?.input_sha256 !== v.digest;
  // Coverage validates first, then writes the generation head and every affected current-g FK
  // in this same root transaction. Any failure rolls back structural and coverage effects together.
  const coverageChanged = await applyRecordingCoverage(scope, x, v.current, v.digest, p);
  if (structuralChanged) {
    await replaceStructuralSupports(scope.personal, v.previous ?? undefined, v.next);
    await sql`insert into personal_context.recording_exposure_contributions
      (universe_id,privacy_epoch,exposure_id,working_generation,explanation_unit_id,qualified,frozen_base,payload,input_sha256)
      values(${u}::uuid,${epoch},${v.next.exposureId}::uuid,${scope.generation},${v.next.explanationUnitId},${v.next.qualified},
      ${JSON.stringify(v.frozen)}::jsonb,${JSON.stringify(v.payload)}::jsonb,${v.digest})
      on conflict(universe_id,exposure_id) do update set working_generation=excluded.working_generation,
      qualified=excluded.qualified,frozen_base=excluded.frozen_base,payload=excluded.payload,input_sha256=excluded.input_sha256`.execute(
      db,
    );
  }
  if (structuralChanged || coverageChanged) await advanceContextState(scope.personal);
  return structuralChanged || coverageChanged;
}
export async function isRecordingContextCurrent(scope: RecordingScopeTx, x: RecordingActivityDerivedInput) {
  const v = await prepare(scope, x);
  return v.old?.input_sha256 === v.digest && (await recordingCoverageCurrent(scope, x, v.digest));
}
