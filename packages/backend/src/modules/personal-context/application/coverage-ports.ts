import type { ObservedCoverage, CheckCoverageEvidence, CheckRecordingCoverageEvidence } from '../../evidence/public.js';
import type { ReadAdmittedCoverageMapping, LockCurrentCoverageAuthorities } from '../../content/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import type { TrustedCoverageQuery, TrustedCoverageRead } from '../domain/coverage.js';
export type ReadTrustedCoverage = (
  scope: PersonalScopeTx,
  query: TrustedCoverageQuery,
) => Promise<TrustedCoverageRead<ObservedCoverage>>;
export interface CoverageDependencies {
  readonly checkEvidence: CheckCoverageEvidence;
  readonly checkRecordingEvidence: CheckRecordingCoverageEvidence;
  readonly readMapping: ReadAdmittedCoverageMapping;
  readonly lockAuthorities: LockCurrentCoverageAuthorities;
}
export interface StoredCoverage {
  readonly activityId: string;
  readonly digest: string;
  readonly certificate: ObservedCoverage;
}

/** One probe: an exact (topic, facet, explanation unit) key of a person's support. */
export type CoverageProbe = TrustedCoverageQuery['probes'][number];

/**
 * The topics whose trusted support changed since Geography last evaluated them, newest change first (#674, D-416).
 * `revision` is the personal-context revision at the read; the personal scope revision of the reading transaction is the
 * bound a consumer clears the rows through (`ClearCoverageDirty`). `hasMore` says more topics are dirty than `limit`.
 * `anySupport` says the person has at least one support key, so an empty set means "nothing changed" and not "nothing read".
 */
export interface CoverageDirty {
  readonly revision: number;
  readonly topics: readonly string[];
  readonly hasMore: boolean;
  readonly anySupport: boolean;
}
/** At most `limit` dirty topics (1..64). Reads only; the personal scope is the caller's. */
export type ReadCoverageDirty = (scope: PersonalScopeTx, query: { readonly limit: number }) => Promise<CoverageDirty>;

/**
 * Deletes the dirty rows of `topicIds` that are at or below `throughRevision`, the personal scope revision at which the
 * caller read them, so evidence that arrived since stays dirty. Returns how many rows went. Runs in the caller's scope.
 */
export type ClearCoverageDirty = (
  scope: PersonalScopeTx,
  input: { readonly topicIds: readonly string[]; readonly throughRevision: number },
) => Promise<number>;

/**
 * Marks every topic the caller has a support key under dirty, at the revision the calling transaction commits at, and
 * returns how many topics. For an explicit request, which wants the whole picture re-read in paced runs.
 */
export type MarkCoverageDirty = (scope: PersonalScopeTx) => Promise<number>;

/**
 * Candidate probes for named topics: for each facet of each topic, its newest `perFacet` support keys (distinct
 * explanation units), newest first, with the topics that have any key. `maxTopics` keeps only the topics whose newest key is the
 * most recent (by topic id for a tie). These index keys are not trusted supports, unit counts or formation authority: a consumer must call
 * the current trusted read under the same root.
 */
export type ReadCoverageInputs = (
  scope: PersonalScopeTx,
  query: { readonly topicIds: readonly string[]; readonly perFacet: number; readonly maxTopics?: number },
) => Promise<{
  readonly revision: number;
  /** The topics (of those asked) that have at least one key, by id. */
  readonly topics: readonly string[];
  readonly probes: readonly CoverageProbe[];
}>;
