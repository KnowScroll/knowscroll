import type { ActivityLineage, RoutingHistory } from './application/navigation-ports.js';
import type { EncounterAttribution } from '../content/public.js';
/**
 * Experience's public surface for other modules and the apps: operation types, outcome schema
 * and the read port the evidence job uses. Commands and queries are built by
 * `adapters/nest-providers.ts` (composition roots only).
 */
import type { PersonalScopeTx } from '../identity/public.js';
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
  readonly kind: ActionKind | 'like' | 'unlike' | 'hide';
  readonly assetId: string;
  readonly assetRevision: number;
  readonly privacyEpoch: number;
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
