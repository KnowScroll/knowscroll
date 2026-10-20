import { sql } from 'kysely';
import type { ActivityDerivedEffect, ActivityDerivedInput } from '../../evidence/public.js';
import { requestHash } from '../../../infrastructure/receipts/index.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { CONTEXT_POLICY, ContributionSchema, type Contribution } from '../domain/context.js';
import { applyProjectedEncounter } from './postgres-store.js';
function contribution(x: ActivityDerivedInput): Contribution {
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
export const activityContextEffect: ActivityDerivedEffect = {
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
