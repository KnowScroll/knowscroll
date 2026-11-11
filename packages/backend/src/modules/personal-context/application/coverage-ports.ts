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
  /** When the earliest topic in backoff may be tried again (ISO), or null when none waits. */
  readonly nextRetryAt: string | null;
}
/** At most `limit` dirty topics (1..64). Reads only; the personal scope is the caller's. */
export type ReadCoverageDirty = (scope: PersonalScopeTx, query: { readonly limit: number }) => Promise<CoverageDirty>;

/**
 * Settles what a run evaluated, in the caller's scope. The dirty rows of `topicIds` at or below `throughRevision` (the personal
 * scope revision at which the caller read them) are deleted, so evidence that arrived since stays dirty. The rows of `deferTopicIds`
 * at or below it are kept and put in backoff instead: they are not offered again until one minute, then two, doubling to an
 * hour, after the last try, and are no longer counted by `ReadCoverageDirty` until then; new evidence ends the backoff. Returns
 * how many rows were deleted.
 */
export type ClearCoverageDirty = (
  scope: PersonalScopeTx,
  input: {
    readonly topicIds: readonly string[];
    readonly throughRevision: number;
    readonly deferTopicIds?: readonly string[];
    /** A deferred row that has been tried this many times is deleted instead: only new evidence or an explicit reconcile brings it back. */
    readonly maxAttempts?: number;
  },
) => Promise<number>;

/**
 * Marks every topic the caller has a support key under dirty, at the revision the calling transaction commits at, and
 * returns how many topics. For an explicit request, which wants the whole picture re-read in paced runs.
 */
export type MarkCoverageDirty = (scope: PersonalScopeTx) => Promise<number>;

/**
 * Candidate probes for named topics: for each facet of each topic, its newest `perFacet` support keys (distinct
 * explanation units), newest first (or the `page`th run of them), with the topics that have any key. `maxTopics` keeps only the topics whose newest key is the
 * most recent (by topic id for a tie). These index keys are not trusted supports, unit counts or formation authority: a consumer must call
 * the current trusted read under the same root.
 */
export type ReadCoverageInputs = (
  scope: PersonalScopeTx,
  query: {
    /** The topics to read. Absent when `recent` names them. */
    readonly topicIds?: readonly string[];
    /** Instead of named topics: the `limit` most recently supported topics other than `exclude`. */
    readonly recent?: { readonly limit: number; readonly exclude: readonly string[] };
    readonly perFacet: number;
    readonly maxTopics?: number;
    /** The page of each facet's keys, newest first: 0 is the newest `perFacet`, 1 the next `perFacet`, and so on. */
    readonly page?: number;
    /** Read only these facets (topic and facet), for the next page of a facet whose newest keys were not trusted. */
    readonly onlyFacets?: readonly { readonly topicId: string; readonly facetId: string }[];
  },
) => Promise<{
  readonly revision: number;
  /** The topics (of those asked) that have at least one key, by id. */
  readonly topics: readonly string[];
  readonly probes: readonly CoverageProbe[];
}>;
