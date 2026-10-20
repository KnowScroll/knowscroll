import type { ReadingFacts } from '../../content/public.js';
import type { ExposureLineage } from '../domain/exposure-lineage.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { ProjectScrollReadingPayload } from '../events.js';

/** An action as the evidence job needs it (read from experience through its public surface). */
export interface ActionToRecord {
  readonly id: string;
  readonly kind: 'save' | 'unsave';
  readonly assetId: string;
  readonly assetRevision: number;
}

export interface ApplyActionEvidencePorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly loadAction: (scope: PersonalScopeTx, actionId: string) => Promise<ActionToRecord | undefined>;
  /** Inserts the evidence row; `false` when this action was already recorded (redelivery). */
  readonly insertActionEvent: (
    scope: PersonalScopeTx,
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
  readonly kind: 'scroll.block_coverage' | 'scroll.active_dwell' | 'scroll.block_interaction';
  readonly instrumentationVersion: number;
  readonly occurredAt: Date;
  readonly receivedAt: Date;
  /** Whether the intake corrected any claim (an interval beyond the elapsed wall time, a future time). */
  readonly bounded: boolean;
  /** The bounded payload, JSON-native. */
  readonly payload: { readonly [key: string]: unknown };
}

/** What the intake knows about an exposure's stored observations. */
export interface IntakeState {
  readonly count: number;
  readonly maxSeq: number;
}

/** Capabilities of `ingestObservations`. Adapters implement them; Nest wires them. */
export interface IngestObservationsPorts {
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
  readonly insertObservation: (scope: PersonalScopeTx, observation: NewObservation) => Promise<boolean>;
  /** Enqueues the projection job in the scope's own transaction (pg-boss is the only outbox). */
  readonly enqueueProjection: (scope: PersonalScopeTx, payload: ProjectScrollReadingPayload) => Promise<void>;
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
}

/** The latest committed evidence revision of an exposure, as the projection compares against it. */
export interface LatestEvidence {
  readonly revision: number;
  readonly inputWatermark: number;
  readonly policyVersion: string;
}

/** One evidence revision to store. */
export interface NewEvidenceRevision {
  readonly id: string;
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
export interface ProjectScrollReadingPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly readExposure: (scope: PersonalScopeTx, exposureId: string) => Promise<ExposureLineage | undefined>;
  readonly readReadingFacts: (
    scope: PersonalScopeTx,
    assetId: string,
    revision: number,
  ) => Promise<ReadingFacts | undefined>;
  /** The exposure's observations in intake order (bounded by the intake limit). */
  readonly readObservations: (scope: PersonalScopeTx, exposureId: string) => Promise<readonly StoredObservation[]>;
  readonly readLatestEvidence: (scope: PersonalScopeTx, exposureId: string) => Promise<LatestEvidence | undefined>;
  /** Inserts the revision; `false` when one already exists for this watermark and policy (redelivery). */
  readonly insertEvidence: (scope: PersonalScopeTx, evidence: NewEvidenceRevision) => Promise<boolean>;
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
