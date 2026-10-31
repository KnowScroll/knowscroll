import type { FormatCell, ReadRecentTopicIds } from '../../evidence/public.js';
export type ReadRecentContextTopics = ReadRecentTopicIds;
import type { PersonalScopeTx } from '../../identity/public.js';
import type { CurrentPlan } from '../../composer/public.js';
import type { Contribution, ContextQuery, CONTEXT_POLICY } from '../domain/context.js';

export interface TopicStatistics {
  readonly topicId: string;
  /** Actual Evidence-owned row presence, independent of whether its corrected values are zero. */
  readonly statisticsAvailability: 'available' | 'not_observed';
  readonly activity: number;
  readonly interest: number;
  readonly channels: Readonly<Record<'q' | 'L' | 'B' | 'S' | 'H' | 'R', number>>;
  readonly formats: readonly {
    readonly kind: 'reel' | 'scroll';
    readonly measured: number;
    readonly qualified: number;
    readonly fit: number;
  }[];
  /** The same counts per play level of the Scroll read; reading only, never a result of play (D-063, D-192). */
  readonly cells: readonly FormatCell[];
}
export interface ExplorationSnapshot {
  readonly version: 'exploration-snapshot.v0';
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly evaluatedAt: string;
  readonly policyVersion: typeof CONTEXT_POLICY;
  readonly revision: number;
  readonly watermarks: { readonly scope: number; readonly projected: number };
  /** Highest applied scope revision is not a claim that a historical rollout finished. */
  readonly completeness: 'not_asserted';
  readonly coverageAvailability: 'unavailable';
  readonly proofAvailability: 'available' | 'unavailable';
  readonly proofReason: 'bounded' | 'limit' | 'unresolved';
  readonly topics: readonly (TopicStatistics & {
    readonly qualifiedExplanationUnits: number;
    readonly coveredFacets: number;
  })[];
  /** Exact requested qualified support probes; never include provisional inputs. */
  readonly qualified: readonly {
    readonly explanationUnitId: string;
    readonly topicIds: readonly string[];
    readonly facets: readonly { readonly facetId: string; readonly topicIds: readonly string[] }[];
  }[];
  readonly supportingEvidence: readonly Contribution[];
  /** Routing-only actual history, including unqualified encounters, independently bounded. */
  readonly routing: {
    readonly recent: readonly {
      readonly exposureId: string;
      readonly activatedAt: string;
      readonly explanationUnitId: string;
      readonly facets: readonly string[];
      readonly topicIds?: readonly string[];
    }[];
    readonly established: readonly {
      readonly explanationUnitId: string;
      readonly encountered: boolean;
      readonly facets: readonly { readonly facetId: string; readonly encountered: boolean }[];
    }[];
    readonly hiddenAssetIds: readonly string[];
  };
  /** IDs-only pending inputs; not qualification, arithmetic or formation support. */
  readonly provisional: {
    readonly purpose: 'routing_only';
    readonly entries: readonly {
      readonly eventId: string;
      readonly exposureId: string;
      readonly inputWatermark: string;
    }[];
    readonly hasMore: boolean;
  };
}
/**
 * The person's current accepted Planner plan at `evaluatedAt`, or undefined when there is none or
 * every opportunity has expired. A cheap stored read for the navigation path: it never reasons,
 * waits on a provider or writes. The Planner module implements it; a plan is never evidence.
 */
export type ReadCurrentPlan = (
  scope: PersonalScopeTx,
  query: { readonly evaluatedAt: string },
) => Promise<CurrentPlan | undefined>;
export type ApplyProjectedEncounter = (scope: PersonalScopeTx, input: Contribution) => Promise<boolean>;
export type ReadExplorationSnapshot = (scope: PersonalScopeTx, query: ContextQuery) => Promise<ExplorationSnapshot>;
export interface ContextPorts {
  readonly apply: ApplyProjectedEncounter;
  readonly readRevision: (scope: PersonalScopeTx) => Promise<{ readonly revision: number; readonly projected: number }>;
  readonly readTopics: (
    scope: PersonalScopeTx,
    ids: readonly string[],
    evaluatedAt: string,
  ) => Promise<readonly TopicStatistics[]>;
  readonly readStructure: (
    scope: PersonalScopeTx,
    query: ContextQuery,
  ) => Promise<{
    readonly proofAvailability: ExplorationSnapshot['proofAvailability'];
    readonly proofReason: ExplorationSnapshot['proofReason'];
    readonly topics: readonly {
      readonly topicId: string;
      readonly qualifiedExplanationUnits: number;
      readonly coveredFacets: number;
    }[];
    readonly qualified: ExplorationSnapshot['qualified'];
    readonly supportingEvidence: readonly Contribution[];
  }>;
  readonly readRouting: (scope: PersonalScopeTx, query: ContextQuery) => Promise<ExplorationSnapshot['routing']>;
  readonly readProvisional: (
    scope: PersonalScopeTx,
    query: { readonly exposureIds: readonly string[]; readonly limit: number },
  ) => Promise<Omit<ExplorationSnapshot['provisional'], 'purpose'>>;
}
