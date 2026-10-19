import type { ApplyActionEvidencePayload } from '../../evidence/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { ActionKind, SavedState } from '../domain/actions.js';

/** JSON a command request or outcome may contain. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** What the receipt store knows about a command key (see infrastructure/receipts). */
export type CommandLookup =
  { readonly kind: 'new' } | { readonly kind: 'replay'; readonly outcome: unknown } | { readonly kind: 'key_reused' };

export interface CommandKey {
  readonly commandId: string;
  readonly operation: string;
  readonly requestHash: string;
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
  readonly findAsset: (
    scope: PersonalScopeTx,
    assetId: string,
  ) => Promise<{ readonly revision: number; readonly admitted: boolean } | undefined>;
  readonly readSavedState: (scope: PersonalScopeTx, assetId: string) => Promise<SavedState>;
  readonly writeSavedState: (
    scope: PersonalScopeTx,
    change: { readonly assetId: string; readonly assetRevision: number; readonly saved: boolean; readonly at: Date },
  ) => Promise<void>;
  readonly recordAction: (scope: PersonalScopeTx, action: ActionRecord) => Promise<void>;
  readonly enqueueActionEvidence: (scope: PersonalScopeTx, payload: ApplyActionEvidencePayload) => Promise<void>;
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
