import type { ReadPreparedEvidenceInput } from '../../composer/public.js';
import { CONTEXT_POLICY, ContextQuerySchema } from '../domain/context.js';
import type { ReadCurrentPlan, ReadExplorationSnapshot } from './ports.js';

const ADAPTER_VERSION = 'personal-context-composer.v0';
/**
 * Compatibility read only: no new score arithmetic, personal truth, projection or write.
 * When a plan reader is supplied the person's current Planner plan rides along, marked as a plan
 * so Composer can never mistake it for evidence.
 */
export function makeReadComposerContext(
  readSnapshot: ReadExplorationSnapshot,
  readCurrentPlan?: ReadCurrentPlan,
): ReadPreparedEvidenceInput {
  return async (scope, query) => {
    const q = ContextQuerySchema.parse({ ...query, provisionalLimit: 0 });
    const s = await readSnapshot(scope, q);
    const topicIds = new Set(q.topicIds),
      candidates = new Map(q.candidates.map((c) => [c.explanationUnitId, c]));
    if (
      s.version !== 'exploration-snapshot.v0' ||
      s.policyVersion !== CONTEXT_POLICY ||
      s.universeId !== scope.authority.universeId ||
      s.privacyEpoch !== scope.authority.privacyEpoch ||
      s.evaluatedAt !== q.evaluatedAt ||
      s.watermarks.scope !== scope.revisionAtEntry ||
      !Number.isSafeInteger(s.revision) ||
      s.revision < 0 ||
      !Number.isSafeInteger(s.watermarks.projected) ||
      s.watermarks.projected < 0 ||
      s.watermarks.projected > scope.revisionAtEntry ||
      s.completeness !== 'not_asserted' ||
      s.coverageAvailability !== 'unavailable' ||
      s.topics.length !== topicIds.size ||
      new Set(s.topics.map((t) => t.topicId)).size !== s.topics.length ||
      s.topics.some(
        (t) => !topicIds.has(t.topicId) || !['available', 'not_observed'].includes(t.statisticsAvailability),
      ) ||
      s.routing.recent.length > 20 ||
      s.routing.recent.some((r) => r.facets.length > 16) ||
      s.routing.established.length > 100 ||
      new Set(s.routing.established.map((u) => u.explanationUnitId)).size !== s.routing.established.length ||
      s.routing.established.some(
        (u) =>
          !candidates.has(u.explanationUnitId) ||
          u.facets.length > 16 ||
          u.facets.some((f) => !candidates.get(u.explanationUnitId)!.facets.includes(f.facetId)),
      ) ||
      s.routing.hiddenAssetIds.length > 100 ||
      s.routing.hiddenAssetIds.some((id) => !q.candidateAssetIds?.includes(id))
    )
      throw new Error('PERSONAL_CONTEXT_COMPOSER_INPUT_INVALID');
    const plan = await readCurrentPlan?.(scope, { evaluatedAt: q.evaluatedAt });
    // A high latest-projection watermark does not assert complete historical reconciliation.
    // A new accepted plan changes what a prepared buffer would offer, so it changes the watermark.
    const watermark = `${ADAPTER_VERSION}:${s.revision}:${s.watermarks.scope}:${s.watermarks.projected}:${s.completeness}${
      plan ? `:plan-${String(plan.revision)}` : ''
    }`;
    return structuredClone({
      universeId: s.universeId,
      privacyEpoch: s.privacyEpoch,
      evaluatedAt: s.evaluatedAt,
      watermark,
      policyVersion: s.policyVersion,
      ...(plan ? { plan } : {}),
      // Row presence is authoritative: observed zero stays zero; absent history stays neutral.
      topics: s.topics
        .filter((t) => t.statisticsAvailability === 'available')
        .map((t) => ({
          topicId: t.topicId,
          activity: t.activity,
          formats: t.formats.map((f) => ({ kind: f.kind, measured: f.measured, qualified: f.qualified })),
        })),
      recent: s.routing.recent,
      established: { policyVersion: 'retained-activated-history.v0', watermark, units: s.routing.established },
      hiddenAssetIds: s.routing.hiddenAssetIds,
    });
  };
}
