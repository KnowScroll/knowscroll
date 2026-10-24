import type { EncounterSnapshot } from '../../content/public.js';
import type {
  FencePersonalRecording,
  PersonalAuthority,
  PersonalScopeTx,
  RecordingScopeTx,
  WithPersonalScope,
} from '../../identity/public.js';
import type { FindAssetForAction, FindOpenableAsset, RenderScroll } from '../../content/public.js';
import type { ActionKind, SavedState } from '../domain/actions.js';
import type { Exposure, ExposureOrigin } from '../domain/exposures.js';

/** JSON a command request or outcome may contain. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * What the receipt store knows about a command key (see infrastructure/receipts): a new key, an
 * identical replay, a reused key, a receipt from an older privacy epoch (never replayed after a
 * reset), or an outcome stored in a version this code cannot read, written by a newer release or
 * by a retired older one.
 */
export type CommandLookup =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly outcome: unknown }
  | { readonly kind: 'key_reused' }
  | { readonly kind: 'epoch_mismatch' }
  | { readonly kind: 'outcome_version_newer' }
  | { readonly kind: 'outcome_version_older' };

export interface CommandKey {
  readonly commandId: string;
  readonly operation: string;
  readonly requestHash: string;
  /** Version of the stored outcome shape; a replay of another version is not parsed as this one. */
  readonly outcomeVersion: number;
}

/** One accepted action, as recorded in `experience.actions`. */
export interface ActionRecord {
  readonly id: string;
  readonly commandId: string;
  readonly kind: ActionKind | 'like' | 'unlike' | 'hide';
  readonly assetId: string;
  readonly assetRevision: number;
  readonly at: Date;
  /** Actual necessary transition, computed BEFORE the Saved write. Never infer from origins. */
  readonly necessaryChanged?: boolean;
  readonly recordingGeneration?: number;
  readonly operation?: string;
}

export interface SavedItem {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly savedAt: Date;
  readonly metadata?: EncounterSnapshot['metadata'];
  readonly availability?: 'available' | 'corrected' | 'withdrawn';
  readonly currentAssetRevision?: number;
}

/** Capabilities the `applyAction` use case needs. Adapters implement them; Nest wires them. */
export interface ApplyActionPorts {
  readonly withPersonalScope: WithPersonalScope;
  readonly hashRequest: (operation: string, request: JsonValue) => string;
  readonly findReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<CommandLookup>;
  readonly insertReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<void>;
  readonly completeReceipt: (
    scope: PersonalScopeTx,
    commandId: string,
    outcome: { readonly [key: string]: JsonValue },
  ) => Promise<void>;
  readonly findAsset: FindAssetForAction;
  readonly readSavedReference: (
    scope: PersonalScopeTx,
    assetId: string,
  ) => Promise<{ readonly assetRevision: number } | undefined>;
  readonly readSavedState: (scope: PersonalScopeTx, assetId: string) => Promise<SavedState>;
  readonly writeSavedState: (
    scope: PersonalScopeTx,
    change: { readonly assetId: string; readonly assetRevision: number; readonly saved: boolean; readonly at: Date },
  ) => Promise<void>;
  readonly recordAction: (
    scope: PersonalScopeTx,
    action: ActionRecord,
  ) => Promise<void | { readonly recording: RecordingChannelsResult }>;
  readonly enqueueActionEvidence: (
    scope: PersonalScopeTx,
    payload: {
      readonly v: 1;
      readonly universeId: string;
      readonly privacyEpoch: number;
      readonly actionId: string;
    },
  ) => Promise<void>;
  /**
   * Advances the universe revision in this transaction: the command's own catch-up watermark.
   * Called only when the command changed something a subscriber reads.
   */
  readonly advanceRevision: (scope: PersonalScopeTx) => Promise<number>;
  /** `pg_notify` the scope change; delivered only if this transaction commits. */
  readonly notifyScopeChanged: (
    scope: PersonalScopeTx,
    change: { readonly revision: number; readonly eventId: string },
  ) => Promise<void>;
  readonly newId: () => string;
  readonly now: () => Date;
}

/** The read port of `listSaved`: rechecks authority (no lock) and reads a bounded page. */
export interface ListSavedPorts {
  readonly readSavedItems: (
    authority: PersonalAuthority,
    limit: number,
  ) => Promise<
    | { readonly kind: 'read'; readonly revision: number; readonly items: readonly SavedItem[] }
    | { readonly kind: 'refused'; readonly reason: 'universe_unavailable' | 'epoch_changed' }
  >;
}

/** The receipt and scope capabilities every experience command shares. */
export interface RecordingCommandHooks {
  readonly fence: FencePersonalRecording;
  readonly remember: (
    scope: PersonalScopeTx,
    key: CommandKey,
    originalGeneration: number | undefined,
    eligibleGeneration: number | undefined,
    at: Date,
  ) => Promise<void>;
  readonly activation: (
    scope: RecordingScopeTx,
    exposureId: string,
    commandId: string,
    at: Date,
    offer?: {
      readonly fresh: boolean;
      readonly eligibleGeneration?: number;
      readonly mode: string;
      readonly source?: string;
    },
  ) => Promise<void>;
  readonly offerOrigin: (scope: PersonalScopeTx, offerId: string) => Promise<number | undefined>;
  readonly bindOfferOrigins: (
    scope: PersonalScopeTx,
    offerIds: readonly string[],
    commandId: string,
    eligibleGeneration: number | undefined,
  ) => Promise<void>;
}
/** A supplied undefined/malformed reserved field must never become legacy omission. */
export function originalRecordingGeneration(command: { readonly recordingGeneration?: number }): number | undefined {
  if (!Object.hasOwn(command, 'recordingGeneration')) return undefined;
  const g = command.recordingGeneration;
  if (!Number.isInteger(g) || g === undefined || g < 1 || g > 2_147_483_647)
    throw new Error('EXPERIENCE_RECORDING_GENERATION_INVALID');
  return g;
}
export function recordingRequest(command: { readonly recordingGeneration?: number }): {
  readonly recordingGeneration?: number;
} {
  const g = originalRecordingGeneration(command);
  return g === undefined ? {} : { recordingGeneration: g };
}
export interface CommandPorts {
  readonly recording?: RecordingCommandHooks;
  readonly withPersonalScope: WithPersonalScope;
  readonly hashRequest: (operation: string, request: JsonValue) => string;
  readonly findReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<CommandLookup>;
  readonly insertReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<void>;
  readonly completeReceipt: (
    scope: PersonalScopeTx,
    commandId: string,
    outcome: { readonly [key: string]: JsonValue },
  ) => Promise<void>;
  readonly newId: () => string;
  readonly now: () => Date;
}

/** One exposure to insert when a Scroll is opened. */
export interface NewExposure {
  readonly id: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly kind: 'scroll' | 'reel';
  readonly origin: ExposureOrigin;
  /** What the client said it can render; the document is negotiated for it. */
  readonly capabilities: JsonValue;
  readonly commandId: string;
  readonly openedAt: Date;
}

export interface OpenExposurePorts extends CommandPorts {
  readonly findOpenableAsset: FindOpenableAsset;
  /** May this caller open this asset? False only for a Scroll ordered for an audience they are not in (D-049). */
  readonly audienceHolds: (authority: PersonalAuthority, assetId: string) => Promise<boolean>;
  readonly insertExposure: (scope: PersonalScopeTx, exposure: NewExposure) => Promise<void>;
}

export interface ActivateExposurePorts extends CommandPorts {
  /** One exposure of the scope's universe, read inside the locked scope. */
  readonly readExposure: (scope: PersonalScopeTx, exposureId: string) => Promise<Exposure | undefined>;
  readonly markActivated: (
    scope: PersonalScopeTx,
    exposureId: string,
    at: Date,
    originalGeneration?: number,
  ) => Promise<void>;
}

/** What rendering an exposure's document needs to know about it. */
export interface ExposureForDocument {
  readonly id: string;
  readonly assetId: string;
  readonly assetRevision: number;
  /** The capabilities the client declared when it opened. */
  readonly capabilities: unknown;
}

/** The read ports of `readExposureDocument`: rechecks authority (no lock) and reads one exposure. */
export interface ReadExposureDocumentPorts {
  readonly readExposure: (
    authority: PersonalAuthority,
    exposureId: string,
  ) => Promise<
    | { readonly kind: 'read'; readonly exposure: ExposureForDocument }
    | { readonly kind: 'refused'; readonly reason: 'exposure_not_found' | 'universe_unavailable' | 'epoch_changed' }
  >;
  readonly renderScroll: RenderScroll;
  /**
   * May this caller read this asset now? True for any asset that is not ordered for an audience; for
   * a Scroll ordered from code it is the ordering module's current answer, so a member who left no
   * longer reads it through an exposure they opened earlier (D-049).
   */
  readonly audienceHolds: (authority: PersonalAuthority, assetId: string) => Promise<boolean>;
}

export type RecordingChannelsResult =
  { readonly changed: false } | { readonly changed: true; readonly revision: number };
