import type { SharedScopeTx } from '../../modules/identity/public.js';
import { sharedTransactionOf } from '../postgres/personal-scope.js';
import type { CanonicalJson } from './canonical.js';
import type { ReceiptLookup } from './personal.js';

/**
 * Identity of a command on a shared scope (conversation, room, exploration). The actor, the
 * destination scope and the operation are part of the key, so the same client command ID used by
 * another person, against another scope or for another operation is a different command
 * (blueprint §19). The scope and the actor both come from the locked `SharedScopeTx` (the actor is
 * the personal scope's account actor), never from the client or the caller's key.
 */
export interface SharedCommandKey {
  readonly operation: string;
  readonly commandId: string;
  readonly requestHash: string;
  readonly outcomeVersion: number;
}

/**
 * Shared-scope counterpart of `findPersonalReceipt`. Requires the shared root to be locked after
 * the actor's personal root (`enterSharedRoot`), which the `SharedScopeTx` capability proves.
 */
export async function findSharedReceipt(shared: SharedScopeTx, key: SharedCommandKey): Promise<ReceiptLookup> {
  const existing = await sharedTransactionOf(shared)
    .selectFrom('receipts.shared_commands')
    .select(['request_hash', 'outcome', 'outcome_version'])
    .where('scope_kind', '=', shared.root.kind)
    .where('scope_id', '=', shared.root.id)
    .where('actor_account_id', '=', actorAccountOf(shared))
    .where('operation', '=', key.operation)
    .where('command_id', '=', key.commandId)
    .executeTakeFirst();
  if (existing === undefined) return { kind: 'new' };
  if (existing.request_hash !== key.requestHash) return { kind: 'key_reused' };
  if (existing.outcome_version > key.outcomeVersion) return { kind: 'outcome_version_newer' };
  if (existing.outcome_version < key.outcomeVersion) return { kind: 'outcome_version_older' };
  if (existing.outcome === null) throw new Error('Receipt without outcome outside its own transaction');
  return { kind: 'replay', outcome: existing.outcome };
}

export async function insertSharedReceipt(shared: SharedScopeTx, key: SharedCommandKey): Promise<void> {
  await sharedTransactionOf(shared)
    .insertInto('receipts.shared_commands')
    .values({
      scope_kind: shared.root.kind,
      scope_id: shared.root.id,
      actor_account_id: actorAccountOf(shared),
      operation: key.operation,
      command_id: key.commandId,
      request_hash: key.requestHash,
      outcome_version: key.outcomeVersion,
    })
    .execute();
}

export async function completeSharedReceipt(
  shared: SharedScopeTx,
  key: SharedCommandKey,
  outcome: { readonly [key: string]: CanonicalJson },
): Promise<void> {
  const result = await sharedTransactionOf(shared)
    .updateTable('receipts.shared_commands')
    .set({ outcome: JSON.stringify(outcome) })
    .where('scope_kind', '=', shared.root.kind)
    .where('scope_id', '=', shared.root.id)
    .where('actor_account_id', '=', actorAccountOf(shared))
    .where('operation', '=', key.operation)
    .where('command_id', '=', key.commandId)
    .where('outcome', 'is', null)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error('Receipt to complete was not pending');
}

/** The acting account of a shared command: the personal scope's account actor. */
function actorAccountOf(shared: SharedScopeTx): string {
  const actor = shared.personal.authority.actor;
  if (actor.kind !== 'account') throw new Error('Shared-scope receipts need an account actor');
  return actor.accountId;
}
