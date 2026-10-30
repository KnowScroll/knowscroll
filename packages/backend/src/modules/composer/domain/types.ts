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
/**
 * The part of a Planner opportunity that Composer reads. Titles, purposes and supply briefs stay
 * with the Planner: ranking needs only where the opportunity points and which threads and
 * formats it suits.
 */
export interface PlannedOpportunity {
  readonly move: 'example' | 'mechanism' | 'limitation' | 'consequence' | 'perspective' | 'connection';
  readonly topicIds: readonly string[];
  readonly explanationUnitId: string;
  readonly eligibility: readonly ('vertical' | 'related')[];
  readonly formats: readonly ('reel' | 'scroll')[];
  readonly expiresAt: string;
  /** `existing` names admitted content (matched by explanation); `missing_supply` is matched by topic only. */
  readonly target: 'existing' | 'missing_supply';
}
/** The person's current accepted plan, opportunities in priority order. A plan is never evidence. */
export interface CurrentPlan {
  readonly revision: number;
  readonly opportunities: readonly PlannedOpportunity[];
}
/** Which opportunity raised which feature of a candidate, kept in the decision record. */
export interface PlanInfluence {
  readonly planRevision: number;
  /** Position of the opportunity in the plan (0 is the highest priority). */
  readonly opportunity: number;
  readonly match: 'unit' | 'topic';
  readonly feature: 'intent' | 'continuity';
  readonly before: number;
  readonly after: number;
}
export interface PreparedEvidenceInput {
  readonly universeId: string;
  readonly privacyEpoch: number;
  readonly evaluatedAt: string;
  readonly watermark: string;
  readonly policyVersion: string;
  /** Optional Planner plan read for this person. Not evidence: it only informs Intent and Continuity. */
  readonly plan?: CurrentPlan;
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
  /** Candidate-relevant actual retained encounter/facet history, not a learning or identity claim. */
  readonly established?: {
    readonly policyVersion: string;
    readonly watermark: string;
    readonly units: readonly {
      readonly explanationUnitId: string;
      readonly encountered: boolean;
      readonly facets: readonly { readonly facetId: string; readonly encountered: boolean }[];
    }[];
  };
  readonly hiddenAssetIds: readonly string[];
}
/** Jev's atomic criteria for one candidate, each in [0,1]. Code combines them (`semanticFitOf`); the model never scores. */
export interface JevCriteria {
  readonly relevance: number;
  readonly appropriateness: number;
  readonly redundancy: number;
}
/**
 * Stored optional semantic assessments for part of a shortlist. A candidate without an entry is
 * neutral (SemanticFit 0.5): absence is never a negative judgement.
 */
export interface SemanticAssessments {
  readonly roleVersion: string;
  readonly model: string;
  readonly assessedAt: string;
  readonly expiresAt: string;
  readonly entries: readonly (EncounterRef & JevCriteria)[];
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
    /**
     * Vertical moves only. The format the person is in: while any candidate of it is eligible the
     * other format is excluded (`format_sticky`). Unlike `format`, a hard requirement of an explicit
     * format switch, it gives way when nothing of the format is eligible.
     */
    readonly stickyFormat?: 'reel' | 'scroll';
    /**
     * Vertical moves only. The series the person is in. Another part of it is a series move, never
     * a new subject, so every candidate of it is excluded (`same_series`) whatever its revision.
     */
    readonly currentSeriesId?: string;
    /**
     * Vertical moves only. The assets the person can reach from this thread by the Related tab (any
     * revision). Another perspective is a related move, never a new subject, so they and their format
     * twins are excluded (`related_target`) unless that would leave nothing to offer.
     */
    readonly relatedAssetIds?: readonly string[];
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
  readonly semanticAssessments?: SemanticAssessments;
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
  /** Present only when a plan opportunity matched this candidate. */
  readonly plan?: PlanInfluence;
  readonly score: number;
}
/** What sticky format did in one decision: `kept` the person's format, or `fell_back` because none of it was eligible. */
export interface StickyFormatOutcome {
  readonly preferred: 'reel' | 'scroll';
  readonly outcome: 'kept' | 'fell_back';
}

/**
 * What the related-target rule did in one decision: `applied` (it excluded `matched` otherwise eligible
 * candidates, possibly none) or `fell_back` (excluding the `matched` candidates would have left nothing to
 * offer, so none were excluded).
 */
export interface RelatedTargetOutcome {
  readonly outcome: 'applied' | 'fell_back';
  readonly matched: number;
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
  /** Present when the input asked for sticky format. */
  readonly stickyFormat?: StickyFormatOutcome;
  /** Present when the input named related targets. */
  readonly relatedTarget?: RelatedTargetOutcome;
  readonly outcome: 'ready' | 'exhausted';
}
