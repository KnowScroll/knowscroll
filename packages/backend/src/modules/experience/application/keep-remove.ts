import {
  RemoveKeepEntrySchema,
  KeepRemovalAcceptanceSchema,
  type KeepEntryRef,
  type KeepRemovalAcceptance,
} from '@knowscroll/contracts';
import type { FenceOwnAccount, PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';
import type { CommandKey, CommandLookup } from './ports.js';
import type { EncounterActionPorts } from './encounter-action.js';
import { KEEP_ROOT_MAX_REVISION } from '../domain/keep-place.js';

export const KEEP_REMOVAL_OPERATION = 'experience.keep-entry-remove';
export const KEEP_REMOVAL_OUTCOME_VERSION = 1;
export type KeepRemovalResult =
  | { readonly kind: 'ok'; readonly value: KeepRemovalAcceptance }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'INVALID_REQUEST'
        | 'UNIVERSE_UNAVAILABLE'
        | 'PRIVACY_EPOCH_CHANGED'
        | 'KEEP_ENTRY_UNAVAILABLE'
        | 'COMMAND_KEY_REUSED'
        | 'SERVICE_UNAVAILABLE';
    };
export interface KeepRemovalPorts {
  readonly withScope: WithPersonalScope;
  readonly fenceOwn: FenceOwnAccount;
  readonly membership: (scope: PersonalScopeTx, assetId: string) => Promise<KeepEntryRef | undefined>;
  readonly findReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<CommandLookup>;
  readonly beginReceipt: (scope: PersonalScopeTx, key: CommandKey) => Promise<void>;
  readonly completeReceipt: (scope: PersonalScopeTx, commandId: string, value: KeepRemovalAcceptance) => Promise<void>;
  readonly readChannels: EncounterActionPorts['readChannels'];
  readonly commitAction: EncounterActionPorts['commitAction'];
  readonly hash: (operation: string, input: unknown) => string;
  readonly advance: EncounterActionPorts['advance'];
  readonly notify: EncounterActionPorts['notify'];
  readonly newId: () => string;
  readonly now: () => Date;
}
const refuse = (code: Extract<KeepRemovalResult, { kind: 'refused' }>['code']): KeepRemovalResult => ({
  kind: 'refused',
  code,
});
const sameMembership = (a: KeepEntryRef, b: KeepEntryRef) =>
  a.assetId.toLowerCase() === b.assetId.toLowerCase() &&
  a.savedEntryId.toLowerCase() === b.savedEntryId.toLowerCase() &&
  a.assetRevision === b.assetRevision;
const sameEcho = (a: KeepEntryRef, b: KeepEntryRef) =>
  a.assetId === b.assetId && a.savedEntryId === b.savedEntryId && a.assetRevision === b.assetRevision;

/** One root-held Unsave transaction. Historical replay precedes the deleted membership check. */
export function makeRemoveKeepEntry(p: KeepRemovalPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<KeepRemovalResult> => {
    const parsed = RemoveKeepEntrySchema.safeParse(input);
    if (!parsed.success) return refuse('INVALID_REQUEST');
    const command = parsed.data;
    const key = {
      commandId: command.commandId,
      operation: KEEP_REMOVAL_OPERATION,
      requestHash: p.hash(KEEP_REMOVAL_OPERATION, command),
      outcomeVersion: KEEP_REMOVAL_OUTCOME_VERSION,
    };
    const entered = await p.withScope(authority, async (scope): Promise<KeepRemovalResult> => {
      if (scope.authority.actor.kind !== 'account') return refuse('UNIVERSE_UNAVAILABLE');
      const gate = await p.fenceOwn(scope);
      if (gate.kind !== 'active') return refuse('UNIVERSE_UNAVAILABLE');
      const lookup = await p.findReceipt(scope, key);
      if (lookup.kind === 'replay') {
        const stored = KeepRemovalAcceptanceSchema.safeParse(lookup.outcome);
        if (
          !stored.success ||
          stored.data.replayed ||
          stored.data.commandId !== command.commandId ||
          stored.data.scope.accountId !== gate.owner.accountId ||
          stored.data.scope.privacyEpoch !== gate.owner.privacyEpoch ||
          !sameEcho(stored.data.entry, command.entry)
        )
          return refuse('SERVICE_UNAVAILABLE');
        // No current membership read: A may be gone, or a later Save may now own B.
        return { kind: 'ok', value: { ...stored.data, replayed: true } };
      }
      if (lookup.kind === 'outcome_version_newer') return refuse('SERVICE_UNAVAILABLE');
      if (lookup.kind !== 'new') return refuse('COMMAND_KEY_REUSED');
      const membership = await p.membership(scope, command.entry.assetId);
      if (!membership || !sameMembership(membership, command.entry)) return refuse('KEEP_ENTRY_UNAVAILABLE');
      const before = await p.readChannels(scope, command.entry.assetId);
      if (!before.saved || before.savedRevision !== membership.assetRevision) return refuse('SERVICE_UNAVAILABLE');
      if (scope.revisionAtEntry >= KEEP_ROOT_MAX_REVISION) return refuse('SERVICE_UNAVAILABLE');
      const at = p.now(),
        actionId = p.newId();
      const value = KeepRemovalAcceptanceSchema.parse({
        version: 'keep-remove.v1',
        scope: { accountId: gate.owner.accountId, privacyEpoch: gate.owner.privacyEpoch },
        commandId: command.commandId,
        recordedAt: at.toISOString(),
        replayed: false,
        outcome: 'accepted',
        operation: 'keep.entry.remove',
        entry: command.entry,
      });
      await p.beginReceipt(scope, key);
      const effect = await p.commitAction(
        scope,
        {
          actionId,
          commandId: command.commandId,
          kind: 'unsave',
          assetId: command.entry.assetId,
          assetRevision: command.entry.assetRevision,
          at,
          operation: KEEP_REMOVAL_OPERATION,
          ...(Object.hasOwn(command, 'recordingGeneration')
            ? { recordingGeneration: command.recordingGeneration }
            : {}),
          necessaryChanged: true,
        },
        before,
      );
      if (!effect.changed) throw new Error('KEEP_REMOVAL_EFFECT_INVARIANT');
      await p.completeReceipt(scope, command.commandId, value);
      const revision = effect.recording?.changed ? effect.recording.revision : await p.advance(scope);
      await p.notify(scope, { revision, eventId: actionId });
      return { kind: 'ok', value };
    });
    return entered.kind === 'entered'
      ? entered.value
      : refuse(entered.refusal.kind === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE');
  };
}
