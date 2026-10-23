import type { KeepEntryRef, KeepPosition, KeepPlaceAcceptance } from '@knowscroll/contracts';
import type { FenceOwnAccount, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { LockKeepPositionTarget } from '../../content/public.js';
import type { CommandKey, CommandLookup } from './ports.js';
export type KeepRefusal =
  | { readonly kind: 'refused'; readonly code: 'KEEP_PLACE_REVISION_STALE'; readonly currentPlaceRevision: number }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'INVALID_REQUEST'
        | 'UNIVERSE_UNAVAILABLE'
        | 'PRIVACY_EPOCH_CHANGED'
        | 'KEEP_ENTRY_UNAVAILABLE'
        | 'COMMAND_KEY_REUSED'
        | 'SERVICE_UNAVAILABLE'
        | 'UNPROCESSABLE_REQUEST'
        | 'KEEP_PLACE_COUNTER_EXHAUSTED';
    };
export type KeepResult<T> = { readonly kind: 'ok'; readonly value: T } | KeepRefusal;
export interface StoredPlace {
  readonly revision: number;
  readonly position: KeepPosition;
}
export interface KeepStore {
  membership(scope: PersonalScopeTx, assetId: string): Promise<KeepEntryRef | undefined>;
  place(scope: PersonalScopeTx, savedEntryId: string): Promise<StoredPlace | undefined>;
  write(scope: PersonalScopeTx, savedEntryId: string, base: number, position: KeepPosition): Promise<void>;
  findReceipt(scope: PersonalScopeTx, key: CommandKey): Promise<CommandLookup>;
  beginReceipt(scope: PersonalScopeTx, key: CommandKey): Promise<void>;
  completeReceipt(scope: PersonalScopeTx, commandId: string, value: KeepPlaceAcceptance): Promise<void>;
}
export interface KeepPorts {
  withScope: WithPersonalScope;
  fenceOwn: FenceOwnAccount;
  target: LockKeepPositionTarget;
  store: KeepStore;
  hash(operation: string, input: unknown): string;
  advance(scope: PersonalScopeTx): Promise<number>;
  notify(scope: PersonalScopeTx, change: { revision: number; eventId: string }): Promise<void>;
  now(): Date;
}
export function keepRefuse(code: Exclude<KeepRefusal['code'], 'KEEP_PLACE_REVISION_STALE'>): KeepRefusal {
  return { kind: 'refused', code };
}
