import type { ObservedCoverage } from '../domain/coverage.js';
import type { ActivityChannels } from '../domain/activity.js';
import type { PersonalScopeTx, RecordingScopeTx } from '../../identity/public.js';
import type { PlayLevel } from '../../content/public.js';
/** Minimal projection event contract, independent of Experience's implementation types. */
export interface LegacyActivityDerivedInput {
  /** Actual current Evidence activity audit identity; unchanged activity reuses its ID. */
  readonly id?: string;
  readonly coverage?: ObservedCoverage;
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
/** Exact current segment proof is separate from carried exposure credit. */
export interface RecordingActivityDerivedInput {
  readonly version: 'recording-activity.v1';
  readonly recordingGeneration: number;
  readonly exposure: LegacyActivityDerivedInput['exposure'];
  readonly metadata: LegacyActivityDerivedInput['metadata'];
  readonly inputVector: LegacyActivityDerivedInput['inputVector'];
  readonly currentSegment: {
    readonly activity: { readonly id: string; readonly recordingGeneration: number; readonly revision: number };
    readonly qualification: {
      readonly id: string;
      readonly recordingGeneration: number;
      readonly revision: number;
    } | null;
    readonly measured: boolean;
    readonly qualified: boolean;
    readonly coverage?: ObservedCoverage;
  };
  readonly evidenceEffective: {
    readonly channels: ActivityChannels;
    readonly measured: boolean;
    readonly qualified: boolean;
  };
}
export type ActivityDerivedInput = LegacyActivityDerivedInput | RecordingActivityDerivedInput;
export interface LegacyActivityDerivedEffect {
  readonly apply: (scope: PersonalScopeTx, projection: LegacyActivityDerivedInput) => Promise<boolean>;
  readonly isCurrent: (scope: PersonalScopeTx, projection: LegacyActivityDerivedInput) => Promise<boolean>;
}
export interface ActivityDerivedEffect extends LegacyActivityDerivedEffect {
  readonly applyRecording: (scope: RecordingScopeTx, projection: RecordingActivityDerivedInput) => Promise<boolean>;
  readonly isRecordingCurrent: (scope: RecordingScopeTx, projection: RecordingActivityDerivedInput) => Promise<boolean>;
}
/**
 * Measured and qualified encounters of one topic and kind at one play level. They count reading
 * only (a qualified response is q >= 0.6), never a pick, a result, a spark or a tier (D-063, D-192).
 */
export interface FormatCell {
  readonly kind: 'reel' | 'scroll';
  readonly level: PlayLevel;
  readonly measured: number;
  readonly qualified: number;
}
export interface ActivityStatistics {
  readonly topicId: string;
  readonly activity: number;
  readonly channels: Readonly<Record<'q' | 'L' | 'B' | 'S' | 'H' | 'R', number>>;
  /** Per kind, over every play level: the parent of the cells. */
  readonly formats: readonly {
    readonly kind: 'reel' | 'scroll';
    readonly measured: number;
    readonly qualified: number;
  }[];
  readonly cells: readonly FormatCell[];
}
export type ReadActivityStatistics = (
  scope: PersonalScopeTx,
  query: { readonly topicIds: readonly string[]; readonly evaluatedAt: string },
) => Promise<readonly ActivityStatistics[]>;
/** One topic of the person's long-term interest: its activity decayed to the read's evaluation time. */
export interface InterestTopic {
  readonly topicId: string;
  readonly activity: number;
}

/**
 * The person's `limit` topics with the most decayed activity at `evaluatedAt` and at least `minActivity` of it (default 0.05),
 * strongest first (ties by topic id). It reads the index on `log_weight` (migration 0117, D-420): a range scan that stops at
 * `limit`, so its cost does not depend on how many topics the person has met. Reading only, like every number here (D-063).
 */
export type ReadTopInterestTopics = (
  scope: PersonalScopeTx,
  query: { readonly limit: number; readonly evaluatedAt: string; readonly minActivity?: number },
) => Promise<readonly InterestTopic[]>;

/**
 * A roll-up of the topics of one system, or of every topic of the person, in the shape of a topic's statistics. It is the sum of
 * the topic rows beneath it, so the roll-up less a topic is "the rest of the system". Decayed to the read's evaluation time.
 */
export interface InterestRollup {
  readonly level: 'system' | 'person';
  /** The catalogue system; empty for the person. */
  readonly subjectId: string;
  readonly activity: number;
  /** Per kind, over every play level and topic below it. */
  readonly formats: readonly {
    readonly kind: 'reel' | 'scroll';
    readonly measured: number;
    readonly qualified: number;
  }[];
}

/** The roll-ups of up to 100 systems and, when asked, of the person. A system or person with no row is absent. */
export type ReadInterestRollups = (
  scope: PersonalScopeTx,
  query: { readonly systemIds: readonly string[]; readonly person: boolean; readonly evaluatedAt: string },
) => Promise<readonly InterestRollup[]>;

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
