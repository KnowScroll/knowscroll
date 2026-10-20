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
  readonly catalogWatermark: string;
  readonly attributionVersion: string;
}
export interface PreparedEvidenceInput {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly evaluatedAt: string;
  readonly watermark: string;
  readonly policyVersion: string;
  /** Already decayed by the authorized projector at evaluatedAt; Composer does not form context. */
  readonly topics: readonly {
    readonly topicId: string;
    readonly activity: number;
    readonly formats: readonly {
      readonly kind: 'reel' | 'scroll';
      readonly measured: number;
      readonly qualified: number;
    }[];
  }[];
  /** Actual activated encounters only, newest first; never offers or generated supply. */
  readonly recent: readonly {
    readonly exposureId: string;
    readonly activatedAt: string;
    readonly explanationUnitId: string;
    readonly facets: readonly string[];
  }[];
  readonly hiddenAssetIds: readonly string[];
}
export interface ComposerSnapshot {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly evaluatedAt: string;
  readonly seed: string;
  readonly mode: 'vertical' | 'horizontal' | 'return' | 'variant';
  readonly intent: {
    readonly language: string;
    readonly format?: 'reel' | 'scroll';
    readonly topicIds: readonly string[];
    readonly requiredTopicIds?: readonly string[];
    readonly continuityLinkId?: string;
    readonly text: string;
    readonly exactTarget?: EncounterRef;
    readonly explanationUnitId?: string;
  };
  readonly source?: EncounterRef;
  readonly candidates: readonly {
    readonly encounter: EncounterSnapshot;
    readonly admitted: boolean;
    readonly accessible: boolean;
    readonly renderable: boolean;
    readonly continuity?: {
      readonly linkId: string;
      readonly source: EncounterRef;
      readonly target: EncounterRef;
      readonly direction: 'previous' | 'next' | 'related';
      readonly strength: number;
    };
  }[];
  readonly explorationPool: readonly EncounterRef[];
  readonly evidence?: PreparedEvidenceInput;
  readonly watermarks: {
    readonly catalog: string;
    readonly continuity: string;
    readonly taxonomy: string;
    readonly context: string;
  };
}
export interface Features {
  readonly intent: number;
  readonly interest: number;
  readonly format: number;
  readonly novelty: number;
  readonly semanticFit: number;
  readonly continuity: number;
  readonly recentRepetition: number;
}
export interface CandidateEvaluation extends EncounterRef {
  readonly explanationUnitId: string;
  readonly eligible: boolean;
  readonly exclusions: readonly string[];
  readonly features: Features;
  readonly score: number;
}
export interface ComposerDecision {
  readonly version: 'composer-decision.v0';
  readonly policyVersion: 'composer-policy.v0';
  readonly fallbackVersion: 'lexical-admitted.v0';
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly evaluatedAt: string;
  readonly seed: string;
  readonly input: ComposerSnapshot;
  readonly evaluations: readonly CandidateEvaluation[];
  readonly selection: readonly (EncounterRef & {
    readonly score: number;
    readonly similarity: number;
    readonly mmr: number;
  })[];
  readonly exploration: {
    readonly fraction: number;
    readonly branch: 'ranked' | 'explore';
    readonly pool: readonly EncounterRef[];
    readonly selectedProbability: number;
    readonly rankedWinner?: EncounterRef;
  };
  readonly outcome: 'ready' | 'exhausted';
}
