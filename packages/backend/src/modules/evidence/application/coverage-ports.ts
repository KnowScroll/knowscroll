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
}
export type PrepareObservedCoverage = (scope: PersonalScopeTx, exposure: CoverageExposure) => Promise<ObservedCoverage>;
/** Returns only exact certificates still bound to latest owned qualified evidence; <=1000 exposures. */
export type CheckCoverageEvidence = (
  scope: PersonalScopeTx,
  certificates: readonly ObservedCoverage[],
) => Promise<readonly string[]>;
export interface ObservedCoveragePorts {
  readonly readEvidence: (scope: PersonalScopeTx, exposureId: string) => Promise<CoverageEvidence | undefined>;
  readonly readMapping: ReadAdmittedCoverageMapping;
  readonly readFacts: ReadScrollReadingFacts;
  readonly hash: (value: unknown) => string;
  readonly bytes: (value: unknown) => number;
}
