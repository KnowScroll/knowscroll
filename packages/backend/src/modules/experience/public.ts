import type { RecordingChannelsResult } from './application/ports.js';
export type { RecordingChannelsResult } from './application/ports.js';
import type { makeRemoveKeepEntry } from './application/keep-remove.js';
import type { SetNotInterested, UndoNotInterested } from './application/not-interested.js';
import type { makeReadKeepEntry, makeSetKeepPlace } from './application/keep-place.js';
import type { ActivityLineage, RoutingHistory } from './application/navigation-ports.js';
import type { EncounterAttribution } from '../content/public.js';
export type { RegionEncounterUseCases, RegionEncounterResult } from './application/region-encounter.js';
export const REGION_ENCOUNTERS = Symbol('experience.regionEncounters');
/**
 * Experience's public surface for other modules and the apps: operation types, outcome schema
 * and the read port the evidence job uses. Commands and queries are built by
 * `adapters/nest-providers.ts` (composition roots only).
 */
import type { PersonalScopeTx, RecordingScopeTx } from '../identity/public.js';
import type { ActionKind } from './domain/actions.js';
import type { ExposureKind } from './domain/exposures.js';

export {
  ACTION_OUTCOME_VERSION,
  ActionOutcomeSchema,
  APPLY_ACTION_OPERATION,
  type ActionOutcome,
  type ApplyAction,
  type ApplyActionCommand,
  type ApplyActionResult,
} from './application/apply-action.js';
export { SAVED_PAGE_LIMIT, type ListSaved, type ListSavedResult } from './application/list-saved.js';
export {
  OPEN_EXPOSURE_OPERATION,
  OpenExposureOutcomeSchema,
  type OpenExposure,
  type OpenExposureCommand,
  type OpenExposureOutcome,
  type OpenExposureResult,
} from './application/open-exposure.js';
export {
  ACTIVATE_EXPOSURE_OPERATION,
  ActivateExposureOutcomeSchema,
  type ActivateExposure,
  type ActivateExposureCommand,
  type ActivateExposureOutcome,
  type ActivateExposureResult,
} from './application/activate-exposure.js';
export type { ReadExposureDocument, ReadExposureDocumentResult } from './application/read-exposure-document.js';
export { EXPOSURE_ORIGINS, type ExposureOrigin } from './domain/exposures.js';

/** An action as the evidence module reads it. */
export interface ActionForEvidence {
  readonly id: string;
  /** Original owning command identity; optional only for older port implementations. */
  readonly commandId?: string;
  readonly kind: ActionKind | 'like' | 'unlike' | 'hide';
  readonly assetId: string;
  readonly assetRevision: number;
  readonly privacyEpoch: number;
  /** Original immutable disposition; absent legacy is literal1 only, never current. */
  readonly recordingOrigin?:
    | { readonly kind: 'legacy' }
    | { readonly kind: 'recorded'; readonly originalGeneration?: number; readonly eligibleGeneration?: number };
}

/**
 * Port: read one action of the scope's universe inside the reader's own locked scope.
 * `undefined` when the action no longer exists (erased).
 */
export type ReadActionForEvidence = (
  scope: PersonalScopeTx,
  actionId: string,
) => Promise<ActionForEvidence | undefined>;

export const READ_ACTION_FOR_EVIDENCE = Symbol('experience.readActionForEvidence');

/**
 * An exposure as the evidence module reads it, to validate an observation's lineage: which revision
 * the exposure presents and whether (and when) its article became the active reading surface.
 */
export interface ExposureForEvidence {
  readonly id: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly kind: ExposureKind;
  readonly openedAt: Date;
  /** Undefined until activation: observations are accepted only for an activated exposure. */
  readonly activatedAt: Date | undefined;
  readonly privacyEpoch: number;
}

/**
 * Port: read one exposure of the scope's universe inside the reader's own locked scope. `undefined`
 * when it does not exist (never opened, another person's, or erased).
 */
export type ReadExposureForEvidence = (
  scope: PersonalScopeTx,
  exposureId: string,
) => Promise<ExposureForEvidence | undefined>;

export const READ_EXPOSURE_FOR_EVIDENCE = Symbol('experience.readExposureForEvidence');

export type {
  NavigationPorts,
  NavigationResult,
  NavigateEncounter,
  ActivateOffer,
  ReadExposureContext,
  ActivityLineage,
  RoutingHistory,
} from './application/navigation-ports.js';
export type ReadActivityLineage = (scope: PersonalScopeTx, exposureId: string) => Promise<ActivityLineage | undefined>;
export type ReadRoutingHistory = (
  scope: PersonalScopeTx,
  query: {
    readonly evaluatedAt: string;
    readonly candidates: readonly { readonly explanationUnitId: string; readonly facets: readonly string[] }[];
    readonly candidateAssetIds: readonly string[];
  },
) => Promise<RoutingHistory>;
export const READ_ACTIVITY_LINEAGE = Symbol('experience.readActivityLineage');
export const READ_ROUTING_HISTORY = Symbol('experience.readRoutingHistory');

export type EnsureActivityLineage = (
  scope: PersonalScopeTx,
  exposureId: string,
  metadata: EncounterAttribution,
) => Promise<void>;
export type ReadActivityReconcilePage = (
  scope: PersonalScopeTx,
  query: { readonly after?: string; readonly limit: number },
) => Promise<readonly string[]>;
export const ENSURE_ACTIVITY_LINEAGE = Symbol('experience.ensureActivityLineage');
export const READ_ACTIVITY_RECONCILE_PAGE = Symbol('experience.readActivityReconcilePage');

/**
 * Port: which of these assets (at most 100) the caller has opened and activated, in any revision.
 * The caller's own history only, at their current epoch; it says nothing about how much was seen
 * and is never a grade, and it never reaches another person.
 */
export type ReadVisitedAssets = (scope: PersonalScopeTx, assetIds: readonly string[]) => Promise<ReadonlySet<string>>;
export const READ_VISITED_ASSETS = Symbol('experience.readVisitedAssets');

/**
 * Port: whether the caller has opened and activated this exact Scroll revision at their current epoch. It
 * is the authority behind anything done *in* an encounter that is not reading (play, #473): a person can only
 * act on what they actually met. The caller's own history only; it says nothing about how much was seen.
 */
export type HasActivatedExposure = (scope: PersonalScopeTx, assetId: string, assetRevision: number) => Promise<boolean>;
export const HAS_ACTIVATED_EXPOSURE = Symbol('experience.hasActivatedExposure');

export type { ApplyEncounterAction } from './application/encounter-action.js';

/** Own activated exact source; optional session must own this exposure and name its latest intent.
 * Reads under the caller personal root. Does not itself grant current Content eligibility.
 */
export type CheckRequestSource = (
  scope: PersonalScopeTx,
  source: {
    readonly exposureId: string;
    readonly assetId: string;
    readonly assetRevision: number;
    readonly session?: { readonly sessionId: string; readonly expectedIntentRevision: number };
  },
) => Promise<boolean>;
export const CHECK_REQUEST_SOURCE = Symbol('experience.checkRequestSource');

export { KEEP_PLACE_OPERATION, KEEP_PLACE_OUTCOME_VERSION } from './application/keep-place.js';
export type { KeepResult, KeepRefusal } from './application/keep-ports.js';
export interface KeepPlaceUseCases {
  readonly readEntry: ReturnType<typeof makeReadKeepEntry>;
  readonly setPlace: ReturnType<typeof makeSetKeepPlace>;
}
export const KEEP_PLACE_USE_CASES = Symbol('experience.keepPlaceUseCases');

export { KEEP_REMOVAL_OPERATION, KEEP_REMOVAL_OUTCOME_VERSION } from './application/keep-remove.js';
export type { KeepRemovalResult } from './application/keep-remove.js';
export type KeepRemovalUseCase = ReturnType<typeof makeRemoveKeepEntry>;
export const KEEP_REMOVAL_USE_CASE = Symbol('experience.keepRemovalUseCase');

export const READ_SAVED_PAGE = Symbol('experience.readSavedPage');
export {
  type ReadSavedPage,
  type SavedPagePorts,
  type SavedPageResult,
  type SavedPageKey,
  type SavedCandidate,
  type SavedCursorBinding,
  type SavedCursorCodec,
} from './application/saved-page.js';

/** Required owning effects for the recording-aware composition. All effects reuse the SAME
 * genuine recording transaction; no root, network, queue bypass or empty fallback is permitted.
 * The legacy composition is limited to genuine initial 1/on and cannot collect after a toggle. */
export interface ExperienceRecordingEffects {
  applyChannels(
    scope: RecordingScopeTx,
    change: {
      readonly commandId: string;
      readonly actionId: string;
      readonly assetId: string;
      readonly channel: 'saved' | 'liked';
      readonly pointerRevision: number;
      readonly changes: readonly {
        readonly exposureId: string;
        readonly value: boolean;
        readonly originActionId: string;
        readonly originGeneration: number;
      }[];
    },
  ): Promise<RecordingChannelsResult>;
  startSession(
    scope: RecordingScopeTx,
    session: {
      readonly exposureId: string;
      readonly sessionId: string;
      /** Sampled inside accepted activation transaction; client starts its clock after ACK. */
      readonly serverStartedAt: Date;
    },
  ): Promise<void>;
  enqueueActivity(scope: RecordingScopeTx, exposureId: string): Promise<void>;
  enqueueActionEvidence(scope: RecordingScopeTx, actionId: string): Promise<void>;
}
export const EXPERIENCE_RECORDING_EFFECTS = Symbol('experience.recordingEffects');

/** Current generation source only. Physical exposure activation is immutable decay time;
 * firstEligibleActivationAt is separate actual activation, absent on correction-only segments. */
export interface RecordingSegment {
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
  readonly likedOverride: boolean | null;
  readonly savedOverride: boolean | null;
  readonly likedDecision: RecordingChannelDecision | null;
  readonly savedDecision: RecordingChannelDecision | null;
  readonly channelRevision: number;
  readonly horizontal: boolean;
  readonly returned: boolean;
  readonly navigationRevision: number;
}
export interface RecordingChannelDecision {
  readonly value: boolean;
  readonly decisionActionId: string;
  readonly originActionId: string;
  readonly originGeneration: number;
}
export type ReadRecordingSegment = (
  scope: RecordingScopeTx,
  exposureId: string,
) => Promise<RecordingSegment | undefined>;
export const READ_RECORDING_SEGMENT = Symbol('experience.readRecordingSegment');

/** Bounded current channel selection. No necessary Saved/Like flag can certify old credit. */
export type RecordingChannelSelection =
  | { readonly kind: 'unavailable' | 'legacy_unknown' | 'not_ready' | 'certified_empty' }
  | {
      readonly kind: 'tracked';
      readonly state: boolean;
      readonly decisionActionId: string;
      readonly originExposureId: string | null;
      readonly originActionId: string | null;
      readonly revision: number;
    };
export type ReadRecordingChannelSelection = (
  scope: RecordingScopeTx,
  input: { readonly assetId: string; readonly channel: 'saved' | 'liked' },
) => Promise<RecordingChannelSelection>;
export const READ_RECORDING_CHANNEL_SELECTION = Symbol('experience.readRecordingChannelSelection');

export type { NotInterestedRefusal, NotInterestedResult } from './application/not-interested.js';
/**
 * "Not interested" (P03, D-055): keeps one asset out of the caller's offers for a while, and takes it
 * back. Each method takes the caller's claimed authority and a parsed body and rechecks authority
 * itself. Neither writes evidence, an action or a job.
 */
export interface NotInterestedUseCases {
  readonly set: SetNotInterested;
  readonly undo: UndoNotInterested;
}
export const NOT_INTERESTED_USE_CASES = Symbol('experience.notInterestedUseCases');
