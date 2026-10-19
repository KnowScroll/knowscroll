import type { PersonalScopeTx } from '../../identity/public.js';
import { readActionForEvidence } from '../../experience/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ActionToRecord } from '../application/ports.js';

/** Reads the action through experience's public surface (experience owns the row). */
export async function loadAction(scope: PersonalScopeTx, actionId: string): Promise<ActionToRecord | undefined> {
  const action = await readActionForEvidence(scope, actionId);
  return action === undefined
    ? undefined
    : { id: action.id, kind: action.kind, assetId: action.assetId, assetRevision: action.assetRevision };
}

/** Inserts one evidence action event; `false` when the action already has one. */
export async function insertActionEvent(
  scope: PersonalScopeTx,
  event: ActionToRecord & { readonly eventId: string },
): Promise<boolean> {
  const inserted = await transactionOf(scope)
    .insertInto('evidence.action_events')
    .values({
      universe_id: scope.authority.universeId,
      id: event.eventId,
      action_id: event.id,
      kind: event.kind,
      asset_id: event.assetId,
      asset_revision: event.assetRevision,
      privacy_epoch: scope.authority.privacyEpoch,
    })
    .onConflict((conflict) => conflict.columns(['universe_id', 'action_id']).doNothing())
    .returning('id')
    .executeTakeFirst();
  return inserted !== undefined;
}
