import type {
  NavigateExperienceRequest,
  NavigationOutcome,
  RecordingObservationBatchRequest,
  RecordingObservationBatchResponse,
} from '@knowscroll/contracts';
import type { FormationReading, OperatorReads } from '../../domain/canary/evaluate.js';
import type { PersonaId, Speed } from '../../domain/canary/personas.js';
import type { ReadingUnit } from '../../domain/canary/reading-plan.js';

/**
 * What the canary needs from the world (#674, D-413). The journeys use `CanaryApi` alone, which is the product's
 * own public HTTP surface with one signed-in session: no database write and no internal use case. Operator reads
 * and the account mint are separate, and are used only before and after the journeys.
 */

/** A refusal or failure of one route, as a stable status and code. Never carries a body. */
export class CanaryApiError extends Error {
  override readonly name = 'CanaryApiError';
  constructor(
    readonly route: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(`${route} ${String(status)} ${code}`);
  }
}

export interface CanaryAccount {
  readonly accountId: string;
  readonly universeId: string;
  readonly privacyEpoch: number;
}

export type NavigationIntent = NavigateExperienceRequest['intent'];

export interface ActivatedOffer {
  readonly exposureId: string;
  readonly intentRevision: number;
}

export interface RegionTarget {
  readonly regionId: string;
  readonly expectedObjectRevision: number;
  readonly expectedGeographyRevision: number;
}

export interface FormationRead {
  readonly reading: FormationReading;
  /** Regions of the places the reader has, to open one by its own target. */
  readonly regions: readonly RegionTarget[];
}

/** One signed-in disposable account driving the public routes, exactly as a client would. */
export interface CanaryApi {
  readonly account: CanaryAccount;
  /** The reader's current recording policy: its generation travels on every command and batch. */
  recordingPolicy(): Promise<{ readonly on: boolean; readonly generation: number }>;
  /** The first open (`discover`): the system chooses what to offer. */
  discover(input: { commandId: string; recordingGeneration: number }): Promise<NavigationOutcome>;
  navigate(input: {
    commandId: string;
    sessionId: string;
    expectedIntentRevision: number;
    from: { offerId: string; exposureId: string };
    intent: NavigationIntent;
    recordingGeneration: number;
  }): Promise<NavigationOutcome>;
  activate(input: {
    commandId: string;
    sessionId: string;
    offerId: string;
    expectedIntentRevision: number;
    recordingGeneration: number;
  }): Promise<ActivatedOffer>;
  /** The reading units of the Scroll the exposure presents, from its consumer document. */
  readingUnits(exposureId: string): Promise<readonly ReadingUnit[]>;
  reelGrant(exposureId: string): Promise<{ readonly durationMs: number; readonly path: string }>;
  /** A ranged read of the grant's first bytes, as a player would make; whether they were served. */
  reelBytesServed(path: string): Promise<boolean>;
  submitBatch(batch: RecordingObservationBatchRequest): Promise<RecordingObservationBatchResponse>;
  formation(): Promise<FormationRead>;
  /**
   * A deliberate region open: the preview card, then the open command. `unavailable` is the preview saying the
   * region has nothing to open now, which is an answer, not a failure.
   */
  openRegion(input: {
    commandId: string;
    target: RegionTarget;
    recordingGeneration: number;
  }): Promise<NavigationOutcome | { readonly status: 'unavailable' }>;
  /** Starts account deletion through the account route; the session ends with it. */
  deleteAccount(receiptId: string): Promise<void>;
  /** The deletion receipt, readable with no session. */
  deletionState(receiptId: string): Promise<'in_progress' | 'needs_retry' | 'completed'>;
  retryDeletion(receiptId: string): Promise<void>;
}

export type MintResult =
  { readonly kind: 'issued'; readonly link: string } | { readonly kind: 'refused'; readonly reason: string };

export interface CanaryAccounts {
  /** Operator sign-in for one disposable address: the existing `issueOperatorSignIn`. */
  mint(address: string): Promise<MintResult>;
  /** Redeems the link through the real HTTP route and returns the signed-in session. */
  signIn(link: string): Promise<CanaryApi>;
}

/** The latest evidence revision of one exposure, as the operator view shows it: its qualification and revision number. */
export interface EvidenceRow {
  readonly exposureId: string;
  readonly revision: number;
  readonly qualification: 'qualified' | 'not_qualified' | 'unknown';
}

/**
 * Read-only operator reads about the canary's own universes. Evidence is read here, not through the dev diagnostics
 * route, because that route answers only for the legacy intake: a recorder-v2 reading is committed under the
 * recording policy, which only the operator view shows.
 */
export interface CanaryReads {
  read(universeIds: readonly string[]): Promise<OperatorReads>;
  /** The latest committed evidence of each exposure of one universe (`ops.journey_events`). */
  evidence(universeId: string): Promise<readonly EvidenceRow[]>;
}

/** Real wall-clock pacing. The server bounds every reading claim by the time since activation, so nothing is faked. */
export interface Pacer {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export interface CanaryPorts {
  readonly accounts: CanaryAccounts;
  readonly reads: CanaryReads;
  readonly pacer: Pacer;
  readonly newId: () => string;
}

export interface CanaryOptions {
  readonly personas: readonly PersonaId[];
  readonly speed: Speed;
  readonly manyReads: number;
  readonly keep: boolean;
  /** The address of a persona's disposable account for this run: unique, and inside the operator pattern. */
  readonly addressFor: (persona: PersonaId) => string;
  /** The bounded wait, in seconds, for projection, formation and Planner runs to settle after the journeys. */
  readonly waitSeconds: number;
}
