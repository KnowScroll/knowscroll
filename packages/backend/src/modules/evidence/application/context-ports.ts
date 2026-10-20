import type { PersonalScopeTx } from '../../identity/public.js';
/** Minimal projection event contract, independent of Experience's implementation types. */
export interface ActivityDerivedInput {
  readonly exposure: {
    readonly exposureId: string;
    readonly assetId: string;
    readonly assetRevision: number;
    readonly activatedAt: string;
  };
  readonly metadata: {
    readonly explanationUnitId: string;
    readonly topics: readonly {
      readonly topicId: string;
      readonly role: 'primary' | 'supporting' | 'incidental';
      readonly weight: number;
    }[];
  };
  readonly qualified: boolean;
  readonly inputVector: Readonly<Record<string, string | number>>;
}
export interface ActivityDerivedEffect {
  readonly apply: (scope: PersonalScopeTx, projection: ActivityDerivedInput) => Promise<boolean>;
  readonly isCurrent: (scope: PersonalScopeTx, projection: ActivityDerivedInput) => Promise<boolean>;
}
export interface ActivityStatistics {
  readonly topicId: string;
  readonly activity: number;
  readonly channels: Readonly<Record<'q' | 'L' | 'B' | 'S' | 'H' | 'R', number>>;
  readonly formats: readonly {
    readonly kind: 'reel' | 'scroll';
    readonly measured: number;
    readonly qualified: number;
  }[];
}
export type ReadActivityStatistics = (
  scope: PersonalScopeTx,
  query: { readonly topicIds: readonly string[]; readonly evaluatedAt: string },
) => Promise<readonly ActivityStatistics[]>;
export type ReadObservationTail = (
  scope: PersonalScopeTx,
  query: { readonly exposureIds: readonly string[]; readonly limit: number },
) => Promise<{
  readonly entries: readonly {
    readonly eventId: string;
    readonly exposureId: string;
    readonly inputWatermark: string;
  }[];
  readonly hasMore: boolean;
}>;

/** Bounded discovery seed by projection recency, never highest raw stored A. */
export type ReadRecentTopicIds = (
  scope: PersonalScopeTx,
  query: { readonly limit: number },
) => Promise<{
  readonly policyVersion: 'recent_projected_topics.v0';
  readonly topicIds: readonly string[];
  readonly hasMore: boolean;
}>;
