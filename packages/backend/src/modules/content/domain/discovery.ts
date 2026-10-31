import type { EncounterTraits } from './traits.js';

/** Shared admitted facts only; never personal activity or model guesses. */
export interface EncounterRef {
  readonly assetId: string;
  readonly assetRevision: number;
}
export interface TopicAttribution {
  readonly topicId: string;
  readonly role: 'primary' | 'supporting' | 'incidental';
  readonly weight: number;
}
export interface EncounterSnapshot extends EncounterRef {
  readonly kind: 'reel' | 'scroll';
  readonly explanationUnitId: string;
  readonly metadata: {
    readonly kind: 'reel' | 'scroll';
    readonly title: string;
    readonly summary: string;
    readonly language: string;
  };
  readonly topics: readonly TopicAttribution[];
  readonly facets: readonly string[];
  readonly siblings: readonly (EncounterRef & { readonly kind: 'reel' | 'scroll' })[];
  readonly series?: { readonly seriesId: string; readonly seriesRevision: number; readonly part: number };
  /** Derived from the stored document (D-192); a snapshot read from storage always carries it. */
  readonly traits?: EncounterTraits;
  readonly catalogWatermark: string;
  readonly attributionVersion: string;
}
export interface EncounterQuery {
  readonly languages: readonly string[];
  readonly formats: readonly ('reel' | 'scroll')[];
  readonly capabilities: unknown;
  readonly topicIds?: readonly string[];
  readonly text?: string;
  readonly limit?: number;
}
export interface ContinuityLink {
  readonly linkId: string;
  readonly revision: number;
  readonly source: EncounterRef;
  readonly target: EncounterRef;
  readonly relation:
    | {
        readonly kind: 'series_step';
        readonly seriesId: string;
        readonly seriesRevision: number;
        readonly part: number;
      }
    | { readonly kind: 'related_move'; readonly label: string };
  readonly direction: 'previous' | 'next' | 'related';
  readonly strength: number;
  readonly authorityReference: string;
}
export interface ContinuityAdmission {
  readonly authorityReference: string;
  readonly series: readonly {
    readonly seriesId: string;
    readonly seriesRevision: number;
    readonly units: readonly (EncounterRef & { readonly part: number })[];
  }[];
  readonly links: readonly ContinuityLink[];
}
export function validateTopics(topics: readonly TopicAttribution[]): void {
  if (
    topics.length > 16 ||
    new Set(topics.map((t) => t.topicId)).size !== topics.length ||
    topics.some(
      (t) =>
        !/^[a-z0-9][a-z0-9._-]{0,159}$/.test(t.topicId) ||
        !['primary', 'supporting', 'incidental'].includes(t.role) ||
        !Number.isFinite(t.weight) ||
        t.weight <= 0 ||
        t.weight > 1,
    ) ||
    topics.reduce((sum, t) => sum + t.weight, 0) > 1 + 1e-12
  )
    throw new Error('CONTENT_ATTRIBUTION_INVALID');
}
