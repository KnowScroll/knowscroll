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
