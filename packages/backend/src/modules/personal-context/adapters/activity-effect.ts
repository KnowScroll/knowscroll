import { sql } from 'kysely';
import type {
  ActivityDerivedEffect,
  LegacyActivityDerivedEffect,
  LegacyActivityDerivedInput,
} from '../../evidence/public.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { CONTEXT_POLICY, ContributionSchema, type Contribution } from '../domain/context.js';
import { applyCoverage, coverageDigest, readStoredCoverage } from './coverage-store.js';
import type { CoverageDependencies } from '../application/coverage-ports.js';
import { advanceContextState } from './postgres-store.js';
import { applyProjectedEncounter } from './postgres-store.js';
import { applyRecordingContext, isRecordingContextCurrent } from './recording-store.js';
function contribution(x: LegacyActivityDerivedInput): Contribution {
  return ContributionSchema.parse({
    version: 'personal-contribution.v0',
    exposureId: x.exposure.exposureId,
    assetId: x.exposure.assetId,
    assetRevision: x.exposure.assetRevision,
    activatedAt: x.exposure.activatedAt,
    explanationUnitId: x.metadata.explanationUnitId,
    qualified: x.qualified,
    coveredFacets: [],
    topics: x.metadata.topics.filter((t) => t.weight > 0).map((t) => ({ topicId: t.topicId, role: t.role })),
    input: {
      qualificationRevision: x.inputVector.qualificationRevision,
      actionRevision: x.inputVector.actionRevision,
      navigationRevision: x.inputVector.navigationRevision,
      attribution: x.inputVector.attribution,
      activityPolicy: x.inputVector.policy,
      projectionPolicy: CONTEXT_POLICY,
    },
  });
}
/** Evidence owns this port's shape; composition supplies the context owner, without a module cycle. */
export const activityContextEffect: LegacyActivityDerivedEffect = {
  apply: (scope, x) => applyProjectedEncounter(scope, contribution(x)),
  async isCurrent(scope, x) {
    const next = contribution(x);
    const r = await sql<{
      input_sha256: string;
    }>`select input_sha256 from personal_context.contributions where universe_id=${scope.authority.universeId}::uuid and privacy_epoch=${scope.authority.privacyEpoch} and exposure_id=${next.exposureId}::uuid`.execute(
      transactionOf(scope),
    );
    return r.rows[0]?.input_sha256 === requestHash(CONTEXT_POLICY, next);
  },
};

/** Shipped required effect. Existing isolated compatibility fixtures may use the legacy effect. */
export function makeCoverageActivityContextEffect(p: CoverageDependencies): ActivityDerivedEffect {
  function checked(x: LegacyActivityDerivedInput) {
    const c = x.coverage;
    if (
      !c ||
      !x.id ||
      c.exposureId !== x.exposure.exposureId ||
      c.assetId !== x.exposure.assetId ||
      c.assetRevision !== x.exposure.assetRevision ||
      c.explanationUnitId !== x.metadata.explanationUnitId ||
      (c.evidence?.revision ?? 0) !== x.inputVector.qualificationRevision
    )
      throw new Error('PERSONAL_COVERAGE_PROJECTION_INVALID');
    return { certificate: c, activityId: x.id };
  }
  return {
    applyRecording: (scope, x) => applyRecordingContext(scope, x, p),
    isRecordingCurrent: isRecordingContextCurrent,
    async apply(scope, x) {
      const { certificate, activityId } = checked(x);
      const legacy = await activityContextEffect.apply(scope, x);
      const coverage = await applyCoverage(scope, activityId, certificate, p);
      if (coverage && !legacy) await advanceContextState(scope);
      return legacy || coverage;
    },
    async isCurrent(scope, x) {
      const { certificate, activityId } = checked(x);
      return (
        (await activityContextEffect.isCurrent(scope, x)) &&
        (await readStoredCoverage(scope, certificate.exposureId))?.digest === coverageDigest(activityId, certificate)
      );
    },
  };
}
