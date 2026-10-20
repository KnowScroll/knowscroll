import type { ObservedCoverage, CheckCoverageEvidence } from '../../evidence/public.js';
import type { ReadAdmittedCoverageMapping, LockCurrentCoverageAuthorities } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { TrustedCoverageQuery, TrustedCoverageRead } from '../domain/coverage.js';
export type ReadTrustedCoverage = (
  scope: PersonalScopeTx,
  query: TrustedCoverageQuery,
) => Promise<TrustedCoverageRead<ObservedCoverage>>;
export interface CoverageDependencies {
  readonly checkEvidence: CheckCoverageEvidence;
  readonly readMapping: ReadAdmittedCoverageMapping;
  readonly lockAuthorities: LockCurrentCoverageAuthorities;
}
export interface StoredCoverage {
  readonly activityId: string;
  readonly digest: string;
  readonly certificate: ObservedCoverage;
}
