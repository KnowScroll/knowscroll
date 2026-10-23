import type { PersonalScopeTx } from '../../identity/public.js';
import type { ReadAdmittedCoverageMapping, ReadScrollReadingFacts } from '../../content/public.js';
import type { CoverageEvidence, ObservedCoverage } from '../domain/coverage.js';
export interface CoverageExposure {
  readonly exposureId: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly activatedAt: string;
  readonly kind: 'reel' | 'scroll';
  readonly explanationUnitId: string;
  readonly recordingGeneration?: number;
  readonly qualificationId?: string;
}
export type PrepareObservedCoverage = (scope: PersonalScopeTx, exposure: CoverageExposure) => Promise<ObservedCoverage>;
/** Returns only exact certificates still bound to latest owned qualified evidence; <=1000 exposures. */
export type CheckCoverageEvidence = (
  scope: PersonalScopeTx,
  certificates: readonly ObservedCoverage[],
) => Promise<readonly string[]>;
export interface ObservedCoveragePorts {
  readonly readEvidence: (
    scope: PersonalScopeTx,
    exposureId: string,
    recordingGeneration?: number,
    qualificationId?: string,
  ) => Promise<CoverageEvidence | undefined>;
  readonly readMapping: ReadAdmittedCoverageMapping;
  readonly readFacts: ReadScrollReadingFacts;
  readonly hash: (value: unknown) => string;
  readonly bytes: (value: unknown) => number;
}

/** Versioned composite proof; exposure alone is never a recording witness key. */
export interface RecordingCoverageWitness {
  readonly version: 'recording-coverage.v1';
  readonly sourceKind: 'legacy' | 'segment';
  readonly recordingGeneration: number;
  readonly activityId: string;
  readonly qualificationId: string;
  readonly certificateSha256: string;
  readonly certificate: ObservedCoverage;
}
export function recordingCoverageKey(w: RecordingCoverageWitness): string {
  return JSON.stringify([
    w.version,
    w.sourceKind,
    w.certificate.exposureId,
    w.recordingGeneration,
    w.activityId,
    w.qualificationId,
    w.certificateSha256,
  ]);
}
export type CheckRecordingCoverageEvidence = (
  scope: PersonalScopeTx,
  witnesses: readonly RecordingCoverageWitness[],
) => Promise<readonly string[]>;
