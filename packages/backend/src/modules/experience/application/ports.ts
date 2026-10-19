import type { ApplyActionEvidencePayload } from '../../evidence/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { FindAssetForAction } from '../../content/public.js';
import type { ActionKind, SavedState } from '../domain/actions.js';

/** JSON a command request or outcome may contain. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * What the receipt store knows about a command key (see infrastructure/receipts): a new key, an
 * identical replay, a reused key, a receipt from an older privacy epoch (never replayed after a
 * reset), or an outcome stored in a version this code cannot read.
 */
export type CommandLookup =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly outcome: unknown }
  | { readonly kind: 'key_reused' }
  | { readonly kind: 'epoch_mismatch' }
  | { readonly kind: 'outcome_version_unsupported' };

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
  readonly kind: ActionKind;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly at: Date;
}

export interface SavedItem {
  readonly assetId: string;
  readonly assetRevision: number;
  readonly savedAt: Date;
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
  readonly readSavedState: (scope: PersonalScopeTx, assetId: string) => Promise<SavedState>;
  readonly writeSavedState: (
    scope: PersonalScopeTx,
    change: { readonly assetId: string; readonly assetRevision: number; readonly saved: boolean; readonly at: Date },
  ) => Promise<void>;
  readonly recordAction: (scope: PersonalScopeTx, action: ActionRecord) => Promise<void>;
  readonly enqueueActionEvidence: (scope: PersonalScopeTx, payload: ApplyActionEvidencePayload) => Promise<void>;
  /** Advances the universe revision in this transaction; the command's own catch-up watermark. */
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
