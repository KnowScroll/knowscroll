import { z } from 'zod';
import type { PersonalAuthority, ScopeRefusal } from '../../identity/public.js';
import { decideActionEffect, type ActionKind } from '../domain/actions.js';
import type { ApplyActionPorts } from './ports.js';

export const APPLY_ACTION_OPERATION = 'experience.apply-action';

export interface ApplyActionCommand {
  readonly commandId: string;
  readonly kind: ActionKind;
  readonly target: { readonly assetId: string; readonly assetRevision: number };
}

/** The stored and returned outcome of an accepted action. Replays return it unchanged. */
export const ActionOutcomeSchema = z.object({
  actionId: z.uuid(),
  kind: z.enum(['save', 'unsave']),
  assetId: z.uuid(),
  assetRevision: z.number().int().min(1),
  saved: z.boolean(),
  changed: z.boolean(),
});

export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>;

export type ApplyActionRefusal =
  'asset_not_found' | 'asset_revision_stale' | 'command_key_reused' | 'epoch_changed' | 'universe_unavailable';

export type ApplyActionResult =
  | { readonly kind: 'applied'; readonly outcome: ActionOutcome; readonly replayed: boolean }
  | { readonly kind: 'refused'; readonly reason: ApplyActionRefusal };

/**
 * `applyAction`: Save or Unsave an asset for the authenticated person (POST /v1/actions).
 *
 * Authority: the caller's account and universe at a privacy epoch, rechecked under the personal
 *   root lock.
 * Steps (one transaction, blueprint §19): lock → receipt lookup (identical replay returns the
 *   stored outcome; different content under the same key is refused) → asset exists, admitted,
 *   at the given revision → insert the receipt → saved-state change → action record → enqueue
 *   `evidence.apply-action` → store the outcome → commit.
 * Side effects: `experience.saved_items`, `experience.actions`, `receipts.personal_commands`, one
 *   pg-boss job — all or nothing. No network call.
 * Failure/retry: any exception rolls everything back; retrying with the same command ID is safe.
 * Refusals write nothing, so a later retry is evaluated again.
 */
export function makeApplyAction(ports: ApplyActionPorts) {
  return async function applyAction(
    authority: PersonalAuthority,
    command: ApplyActionCommand,
  ): Promise<ApplyActionResult> {
    const request = {
      kind: command.kind,
      target: { assetId: command.target.assetId, assetRevision: command.target.assetRevision },
    };
    const key = {
      commandId: command.commandId,
      operation: APPLY_ACTION_OPERATION,
      requestHash: ports.hashRequest(APPLY_ACTION_OPERATION, request),
    };
    const entered = await ports.withPersonalScope(authority, async (scope): Promise<ApplyActionResult> => {
      const lookup = await ports.findReceipt(scope, key);
      switch (lookup.kind) {
        case 'key_reused':
          return { kind: 'refused', reason: 'command_key_reused' };
        case 'replay':
          return { kind: 'applied', outcome: ActionOutcomeSchema.parse(lookup.outcome), replayed: true };
        case 'new':
          break;
      }
      const asset = await ports.findAsset(scope, command.target.assetId);
      if (asset === undefined || !asset.admitted) return { kind: 'refused', reason: 'asset_not_found' };
      if (asset.revision !== command.target.assetRevision) return { kind: 'refused', reason: 'asset_revision_stale' };

      await ports.insertReceipt(scope, key);
      const effect = decideActionEffect(await ports.readSavedState(scope, command.target.assetId), command.kind);
      const actionId = ports.newId();
      const at = ports.now();
      if (effect.changed) {
        await ports.writeSavedState(scope, {
          assetId: command.target.assetId,
          assetRevision: command.target.assetRevision,
          saved: effect.saved,
          at,
        });
      }
      await ports.recordAction(scope, {
        id: actionId,
        commandId: command.commandId,
        kind: command.kind,
        assetId: command.target.assetId,
        assetRevision: command.target.assetRevision,
        at,
      });
      await ports.enqueueActionEvidence(scope, {
        v: 1,
        universeId: authority.universeId,
        privacyEpoch: authority.privacyEpoch,
        actionId,
      });
      const outcome: ActionOutcome = {
        actionId,
        kind: command.kind,
        assetId: command.target.assetId,
        assetRevision: command.target.assetRevision,
        saved: effect.saved,
        changed: effect.changed,
      };
      await ports.completeReceipt(scope, command.commandId, outcome);
      return { kind: 'applied', outcome, replayed: false };
    });
    return entered.kind === 'entered' ? entered.value : { kind: 'refused', reason: refusalOf(entered.refusal) };
  };
}

export type ApplyAction = ReturnType<typeof makeApplyAction>;

function refusalOf(refusal: ScopeRefusal): ApplyActionRefusal {
  switch (refusal.kind) {
    case 'epoch_changed':
      return 'epoch_changed';
    case 'universe_missing':
    case 'universe_suspended':
    case 'account_mismatch':
      return 'universe_unavailable';
  }
}
