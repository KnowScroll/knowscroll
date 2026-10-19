import type { PersonalScopeTx } from '../../identity/public.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ActionToRecord } from '../application/ports.js';

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
