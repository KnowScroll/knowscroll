import type { ComposerPolicyVersion } from './policy.js';

export interface EncounterRef {
  readonly assetId: string;
  readonly assetRevision: number;
}
/** How much a Scroll asks of the reader beyond reading it. Reels, and every Scroll before v2, are `plain`. */
export type PlayLevel = 'plain' | 'stage' | 'game';
/**
 * What Content derives from the stored document, public facts of the content and never of the reader. The
 * play level and the minutes rank; the claim and the series size only describe the candidate to Jev.
 */
export interface EncounterTraits {
  readonly playLevel: PlayLevel;
  readonly readingMinutes?: number;
  /** The common wrong idea the Scroll is built to meet (its public Plot twist text); absent for none. */
  readonly misconceptionClaim?: string;
  /** How many parts the Scroll's series has, when it is in one. */
  readonly seriesTotal?: number;
}
export interface TopicAttribution {
  readonly topicId: string;
  readonly role: 'primary' | 'supporting' | 'incidental';
  readonly weight: number;
}
/**
 * The retrieval lane that read a candidate first (policy v3, D-420), named as Content names it: the encounter's own topics
 * (`source`), a unit a Planner opportunity names (`planned`), text the person typed (`text`), the person's top interest topics
 * (`continue`), the other topics of the source's systems (`adjacent`) or a sample of the whole library stratified by system
 * (`explore`). Recorded with the candidate; never read by scoring.
 */
export type RetrievalLane = 'source' | 'planned' | 'text' | 'continue' | 'adjacent' | 'explore';
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
  /** Absent in decisions stored before policy v1, and for Reels; read as `plain`. */
  readonly traits?: EncounterTraits;
  readonly catalogWatermark: string;
  readonly attributionVersion: string;
  /** Absent in decisions stored before policy v3, and when retrieval did not name lanes. */
  readonly lane?: RetrievalLane;
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
/** A roll-up of reading over several topics, in the shape of one topic's statistics: activity and measured/qualified counts per kind. */
export interface InterestRollup {
  readonly activity: number;
  readonly formats: readonly {
    readonly kind: 'reel' | 'scroll';
    readonly measured: number;
    readonly qualified: number;
  }[];
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
    /** Measured and qualified encounters of the topic per kind, over every play level (the parent). */
    readonly formats: readonly {
      readonly kind: 'reel' | 'scroll';
      readonly measured: number;
      readonly qualified: number;
    }[];
    /**
     * The same counts per play level of the Scroll read. Reading only: no correctness, pick, spark or
     * tier is an input here (D-063). Absent in inputs stored before policy v1.
     */
    readonly cells?: readonly {
      readonly kind: 'reel' | 'scroll';
      readonly level: PlayLevel;
      readonly measured: number;
      readonly qualified: number;
    }[];
  }[];
  /**
   * The person's overall level (policy v3, D-420): the roll-up of every topic they have met, decayed to the evaluation time.
   * Reading only (D-063). Absent in inputs stored before policy v3, and when the person has none.
   */
  readonly person?: InterestRollup;
  /**
   * The roll-ups of the systems of the candidates' topics (policy v3), each the sum of its topics, so a system less one topic is
   * the rest of the system. A system the person has no row for is absent.
   */
  readonly systems?: readonly (InterestRollup & { readonly systemId: string })[];
  /**
   * The catalogue system of each candidate topic the catalogue holds (policy v3). Frozen at assembly from Content's catalogue, so
   * a later catalogue never changes a stored decision.
   */
  readonly topicSystems?: readonly { readonly topicId: string; readonly systemId: string }[];
  /** Actual activated encounters only, newest first; never offers or generated supply. */
  readonly recent: readonly {
    readonly exposureId: string;
    readonly activatedAt: string;
    readonly explanationUnitId: string;
    readonly facets: readonly string[];
    /** Non-incidental topics of the encounter, when known. Absent in inputs stored before policy v1. */
    readonly topicIds?: readonly string[];
  }[];
  /** Candidate-relevant actual retained encounter/facet history, not a learning or identity claim. */
  readonly established?: {
    readonly policyVersion: string;
    readonly watermark: string;
    readonly units: readonly {
      readonly explanationUnitId: string;
      /** An activated exposure of this explanation exists, in either format (a routing fact, never a learning claim). */
      readonly encountered: boolean;
      /**
       * When the newest such exposure was activated. Absent when not encountered, and in inputs stored before policy v2.
       * Only the last resort of policy v2 reads it, to offer the least recently met explanation.
       */
      readonly lastEncounteredAt?: string;
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
    /**
     * Vertical moves only (policy v2). The topics, among those of the candidates, that belong to a system one of the
     * source's topics belongs to: the `same_system` place (analytics). Frozen at assembly so a replay never depends on
     * the catalogue as it is later. Absent in inputs stored before policy v2 (the step is then empty).
     */
    readonly systemTopicIds?: readonly string[];
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
  /** Policy v1, vertical moves only: how much of the person's last encounters were on the candidate's topic. */
  readonly recentTopic?: number;
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

/**
 * Where an explanation sits relative to the source of a vertical move: about a topic the source is about
 * (`source_topic`), about another topic of a system the source's topics belong to (`same_system`), or neither
 * (`elsewhere`, and every explanation when the move has no source). It is recorded for analytics only: selection never
 * reads it, so a subject move keeps leaving the topic as often as policy v1's scoring says (D-190).
 */
export type SourcePlace = 'source_topic' | 'same_system' | 'elsewhere';

/**
 * What policy v2's two tiers did in one decision (vertical moves without an exact target): `unseen` (every offer is
 * an explanation the person has not met, ranked by the usual score), `fell_back` (nothing unseen was eligible in either
 * format, so the least recently met were offered: the last resort) or `none` (nothing at all was eligible: the existing
 * exhausted path). The places are analytics and never affect which offers were chosen.
 */
export interface UnseenLadderOutcome {
  readonly outcome: 'unseen' | 'fell_back' | 'none';
  /** The place of the first offer; absent when nothing was offered. */
  readonly place?: SourcePlace;
  /** The place of each offer, in selection order. */
  readonly offerPlaces: readonly SourcePlace[];
  /** The eligible candidates by place: unseen ones under `unseen`, met ones under `fell_back`. */
  readonly eligible: Readonly<Record<SourcePlace, number>>;
}

/**
 * What policy v3's format exploration did in one decision (system-chosen vertical moves that name the format the person is in).
 * A draw at `fraction` takes the first offer from the other format: `other_format` when the draw hit, `person_format` when it
 * did not. `propensity` is the probability of the branch actually taken, so an off-policy estimate can weight it. Absent when the
 * move cannot explore: an explicit format request, no other-format candidate eligible, the person's format already fell back, or
 * a policy without it.
 */
export interface FormatExplorationOutcome {
  readonly fraction: number;
  readonly branch: 'person_format' | 'other_format';
  readonly personFormat: 'reel' | 'scroll';
  readonly propensity: number;
}

export interface ComposerDecision {
  readonly version: 'composer-decision.v0';
  /** The policy the decision was made under; it replays under exactly this policy. */
  readonly policyVersion: ComposerPolicyVersion;
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
  /** Present under policy v2 for a system-chosen vertical move. */
  readonly unseenLadder?: UnseenLadderOutcome;
  /** Present under policy v3 when format exploration was drawn for this move. */
  readonly formatExploration?: FormatExplorationOutcome;
  readonly outcome: 'ready' | 'exhausted';
}
