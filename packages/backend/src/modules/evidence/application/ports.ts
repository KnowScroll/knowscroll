import type { EncounterAttribution, ReadingFacts } from '../../content/public.js';
import type { ExposureLineage } from '../domain/exposure-lineage.js';
import type {
  PersonalAuthority,
  PersonalScopeTx,
  WithPersonalScope,
  FenceOwnAccount,
  FencePersonalRecording,
  RecordingScopeTx,
} from '../../identity/public.js';
import type { ProjectScrollReadingPayload } from '../events.js';

/** Structural owning read seam; the outer adapter binds Experience's genuine public port.
 * Keeping this minimal contract local avoids public Evidence→Experience→Geography cycles. */
export interface RecordingSegmentInput {
  readonly recordingGeneration: number;
  readonly exposure: {
    readonly exposureId: string;
    readonly assetId: string;
    readonly assetRevision: number;
    readonly kind: 'reel' | 'scroll';
    readonly activatedAt: string;
    readonly explanationUnitId: string;
  };
  readonly metadata: EncounterAttribution;
  readonly attributionSha256: string;
  readonly initializedAt: string;
  readonly firstEligibleActivationAt?: string;
  readonly savedOverride: boolean | null;
  readonly likedOverride: boolean | null;
  readonly savedDecision: RecordingChannelDecisionInput | null;
  readonly likedDecision: RecordingChannelDecisionInput | null;
  readonly channelRevision: number;
  readonly horizontal: boolean;
  readonly returned: boolean;
  readonly navigationRevision: number;
}
interface RecordingChannelDecisionInput {
  readonly value: boolean;
  readonly decisionActionId: string;
  readonly originActionId: string;
  readonly originGeneration: number;
}
export type ReadEvidenceRecordingSegment = (
  cap: RecordingScopeTx,
  id: string,
) => Promise<RecordingSegmentInput | undefined>;
/** An action as the evidence job needs it (read from experience through its public surface). */
export interface ActionToRecord {
  readonly id: string;
  readonly kind: 'save' | 'unsave' | 'like' | 'unlike' | 'hide';
  readonly assetId: string;
  readonly assetRevision: number;
  readonly recordingOrigin?:
    | { readonly kind: 'legacy' }
    | { readonly kind: 'recorded'; readonly originalGeneration?: number; readonly eligibleGeneration?: number };
}

export interface RecordingAuthorityPorts {
  readonly fenceOwn: FenceOwnAccount;
  readonly fenceRecording: FencePersonalRecording;
}

export interface ApplyActionEvidencePorts extends RecordingAuthorityPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly loadAction: (scope: PersonalScopeTx, actionId: string) => Promise<ActionToRecord | undefined>;
  /** Inserts the evidence row; `false` when this action was already recorded (redelivery). */
  readonly insertActionEvent: (
    scope: RecordingScopeTx,
    event: ActionToRecord & { readonly eventId: string },
  ) => Promise<boolean>;
  readonly newId: () => string;
}

// ── Scroll observations (S1.6, #229) ────────────────────────────────────────────────────────

/** One observation to store, after the intake bounded its claims. */
export interface NewObservation {
  readonly id: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly deviceSequence: number;
  readonly exposureId: string;
  /** Intake order within the exposure; the highest is the exposure's input watermark. */
  readonly seq: number;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly kind: 'scroll.block_coverage' | 'scroll.active_dwell' | 'scroll.block_interaction' | 'reel.playback';
  readonly instrumentationVersion: number;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  /** Whether the intake corrected any claim (an interval beyond the elapsed wall time, a future time). */
  readonly bounded: boolean;
  /** The bounded payload, JSON-native. */
  readonly payload: { readonly [key: string]: unknown };
  readonly recordingGeneration: number;
}

/** What the intake knows about an exposure's stored observations. */
export interface IntakeState {
  readonly count: number;
  readonly maxSeq: number;
}

/** Capabilities of `ingestObservations`. Adapters implement them; Nest wires them. */
export interface IngestObservationsPorts extends RecordingAuthorityPorts {
  readonly withPersonalScope: WithPersonalScope;
  /** The exposure's lineage, read inside the locked scope (experience's public port). */
  readonly readExposure: (scope: PersonalScopeTx, exposureId: string) => Promise<ExposureLineage | undefined>;
  /** The revision's reading facts, read inside the locked scope (content's public port). */
  readonly readReadingFacts: (
    scope: PersonalScopeTx,
    assetId: string,
    revision: number,
  ) => Promise<ReadingFacts | undefined>;
  readonly readIntakeState: (scope: PersonalScopeTx, exposureId: string) => Promise<IntakeState>;
  /** Inserts one observation; `false` when its event ID already exists in this universe (a retry). */
  readonly insertObservation: (scope: RecordingScopeTx, observation: NewObservation) => Promise<boolean>;
  /** Enqueues the projection job in the scope's own transaction (pg-boss is the only outbox). */
  readonly enqueueProjection: (scope: RecordingScopeTx, payload: ProjectScrollReadingPayload) => Promise<void>;
  readonly hasRecordingSession: (scope: RecordingScopeTx, sessionId: string) => Promise<boolean>;
  readonly readRecordingSession: (
    scope: RecordingScopeTx,
    exposureId: string,
    sessionId: string,
  ) => Promise<Date | undefined>;
  readonly findEvent: (
    scope: RecordingScopeTx,
    eventId: string,
  ) => Promise<{ readonly generation: number; readonly wireSha256?: string } | undefined>;
  readonly hashEvent: (value: unknown) => string;
  readonly newId: () => string;
  readonly now: () => Date;
}

/** A stored observation as the projection reads it. */
export interface StoredObservation {
  readonly seq: number;
  readonly sessionId: string;
  readonly deviceSequence: number;
  readonly instrumentationVersion: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly recordingGeneration: number;
  readonly clockDomain: 'legacy' | 'session';
  readonly receivedAt: Date;
  readonly originalWireProved: boolean;
  readonly serverStartedAt?: Date;
}

/** The latest committed evidence revision of an exposure, as the projection compares against it. */
export interface LatestEvidence {
  readonly revision: number;
  readonly inputWatermark: number;
  readonly policyVersion: string;
  readonly id: string;
}

/** One evidence revision to store. */
export interface NewEvidenceRevision {
  readonly id: string;
  readonly recordingGeneration: number;
  readonly clockDomain: 'legacy' | 'session';
  readonly exposureId: string;
  readonly revision: number;
  readonly inputWatermark: number;
  readonly policyVersion: string;
  readonly qualification: 'qualified' | 'not_qualified' | 'unknown';
  readonly q: number;
  readonly coverage: number;
  readonly activeDwellMs: number;
  readonly estimatedReadingMs: number;
  readonly assetId: string;
  readonly assetRevision: number;
  /** Bounded, versioned: seen blocks, interactions, reason codes. */
  readonly summary: { readonly [key: string]: unknown };
}

/** Capabilities of `projectScrollReading` (the worker's job). */
export interface ProjectScrollReadingPorts extends RecordingAuthorityPorts {
  readonly readSegment: ReadEvidenceRecordingSegment;
  readonly withPersonalScope: WithPersonalScope;
  readonly readExposure: (scope: PersonalScopeTx, exposureId: string) => Promise<ExposureLineage | undefined>;
  readonly readReadingFacts: (
    scope: PersonalScopeTx,
    assetId: string,
    revision: number,
  ) => Promise<ReadingFacts | undefined>;
  /** The exposure's observations in intake order (bounded by the intake limit). */
  readonly readObservations: (
    scope: RecordingScopeTx,
    exposureId: string,
    domain: 'legacy' | 'session',
  ) => Promise<
    { readonly kind: 'read'; readonly observations: readonly StoredObservation[] } | { readonly kind: 'limit' }
  >;
  readonly readLatestEvidence: (
    scope: RecordingScopeTx,
    exposureId: string,
    domain: 'legacy' | 'session',
  ) => Promise<LatestEvidence | undefined>;
  /** Inserts the revision; `false` when one already exists for this watermark and policy (redelivery). */
  readonly insertEvidence: (scope: RecordingScopeTx, evidence: NewEvidenceRevision) => Promise<boolean>;
  readonly nextEvidenceRevision: (scope: RecordingScopeTx, exposureId: string) => Promise<number>;
  /** Advances the universe revision in this transaction: the evidence commit's catch-up watermark. */
  readonly advanceRevision: (scope: PersonalScopeTx) => Promise<number>;
  /** `pg_notify` the scope change; delivered only if this transaction commits. Disposable. */
  readonly notifyScopeChanged: (
    scope: PersonalScopeTx,
    change: { readonly revision: number; readonly eventId: string },
  ) => Promise<void>;
  readonly newId: () => string;
}

/** What the dev diagnostics view reads about one exposure's evidence. */
export interface EvidenceDiagnostics {
  readonly revision: number;
  readonly exposureId: string;
  readonly observations: { readonly count: number; readonly lastReceivedAt: Date | undefined };
  readonly evidence:
    | {
        readonly revision: number;
        readonly inputWatermark: number;
        readonly policyVersion: string;
        readonly qualification: 'qualified' | 'not_qualified' | 'unknown';
        readonly q: number;
        readonly coverage: number;
        readonly activeDwellMs: number;
        readonly estimatedReadingMs: number;
        readonly committedAt: Date;
      }
    | undefined;
}

/** The diagnostics read: rechecks authority (no lock) and reads the exposure's durable evidence state. */
export interface ReadEvidenceDiagnosticsPorts {
  readonly readDiagnostics: (
    authority: PersonalAuthority,
    exposureId: string,
  ) => Promise<
    | { readonly kind: 'read'; readonly diagnostics: EvidenceDiagnostics }
    | { readonly kind: 'refused'; readonly reason: 'universe_unavailable' | 'epoch_changed' }
  >;
}
