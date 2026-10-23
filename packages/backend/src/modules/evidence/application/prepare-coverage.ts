import {
  ObservedCoverageSchema,
  OBSERVED_COVERAGE_POLICY,
  observedBindings,
  type ObservedCoverage,
} from '../domain/coverage.js';
import type { ObservedCoveragePorts, PrepareObservedCoverage } from './coverage-ports.js';
export function makePrepareObservedCoverage(p: ObservedCoveragePorts): PrepareObservedCoverage {
  return async (scope, exposure) => {
    let value: ObservedCoverage = {
      version: OBSERVED_COVERAGE_POLICY,
      universeId: scope.authority.universeId,
      privacyEpoch: scope.authority.privacyEpoch,
      exposureId: exposure.exposureId,
      assetId: exposure.assetId,
      assetRevision: exposure.assetRevision,
      activatedAt: exposure.activatedAt,
      explanationUnitId: exposure.explanationUnitId,
      availability: 'unavailable',
      reason: 'unsupported_format',
      evidence: null,
      factsSha256: null,
      mapping: null,
      bindings: [],
    };
    const result = (reason: ObservedCoverage['reason']) => ObservedCoverageSchema.parse({ ...value, reason });
    const evidence = await p.readEvidence(
      scope,
      exposure.exposureId,
      exposure.recordingGeneration,
      exposure.qualificationId,
    );
    if (!evidence) return result(exposure.kind === 'scroll' ? 'qualification_missing' : 'unsupported_format');
    value = {
      ...value,
      evidence: {
        id: evidence.id,
        revision: evidence.revision,
        inputWatermark: evidence.inputWatermark,
        policyVersion: evidence.policyVersion,
        summarySha256: p.hash(evidence.summary),
      },
    };
    if (exposure.kind !== 'scroll') return result('unsupported_format');
    if (evidence.assetId !== exposure.assetId || evidence.assetRevision !== exposure.assetRevision)
      return result('identity_mismatch');
    const map = await p.readMapping(scope, { assetId: exposure.assetId, assetRevision: exposure.assetRevision });
    if (map.kind !== 'mapped') return result(`mapping_${map.kind}`);
    const { version: _version, bindings: _bindings, ...identity } = map.head.mapping;
    value = { ...value, mapping: { authority: map.head.authority, ...identity } };
    if (identity.explanationUnitId !== exposure.explanationUnitId) {
      value = { ...value, mapping: null };
      return result('identity_mismatch');
    }
    const facts = await p.readFacts(scope, exposure.assetId, exposure.assetRevision);
    if (!facts) return result('facts_unavailable');
    value = { ...value, factsSha256: p.hash(facts) };
    if (evidence.qualification !== 'qualified') return result('unqualified');
    const bindings = observedBindings(evidence, facts, map.head, p.hash);
    if (!bindings) return result('evidence_invalid');
    const available: ObservedCoverage = {
      ...value,
      availability: 'available',
      reason: 'observed',
      bindings: bindings.map((b) => ({ ...b, requiredBlockIds: [...b.requiredBlockIds] })),
    };
    if (p.bytes(available) > 16384) return result('limit');
    return ObservedCoverageSchema.parse(available);
  };
}
