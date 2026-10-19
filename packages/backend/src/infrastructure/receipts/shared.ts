import type { Transaction } from 'kysely';
import type { Database } from '../postgres/database.js';
import type { CanonicalJson } from './canonical.js';
import type { ReceiptLookup } from './personal.js';

/**
 * Identity of a command on a shared scope (conversation, room, exploration). The actor, the
 * destination scope and the operation are part of the key, so the same client command ID used by
 * another person, against another scope or for another operation is a different command
 * (blueprint §19). Used inside the transaction that holds the shared root lock, which is taken
 * after the actor's personal root.
 */
export interface SharedCommandKey {
  readonly scopeKind: string;
  readonly scopeId: string;
  readonly actorAccountId: string;
  readonly operation: string;
  readonly commandId: string;
  readonly requestHash: string;
}

function whereKey(trx: Transaction<Database>, key: SharedCommandKey) {
  return trx
    .selectFrom('receipts.shared_commands')
    .where('scope_kind', '=', key.scopeKind)
    .where('scope_id', '=', key.scopeId)
    .where('actor_account_id', '=', key.actorAccountId)
    .where('operation', '=', key.operation)
    .where('command_id', '=', key.commandId);
}

export async function findSharedReceipt(trx: Transaction<Database>, key: SharedCommandKey): Promise<ReceiptLookup> {
  const existing = await whereKey(trx, key).select(['request_hash', 'outcome']).executeTakeFirst();
  if (existing === undefined) return { kind: 'new' };
  if (existing.request_hash !== key.requestHash) return { kind: 'key_reused' };
  if (existing.outcome === null) throw new Error('Receipt without outcome outside its own transaction');
  return { kind: 'replay', outcome: existing.outcome };
}

export async function insertSharedReceipt(trx: Transaction<Database>, key: SharedCommandKey): Promise<void> {
  await trx
    .insertInto('receipts.shared_commands')
    .values({
      scope_kind: key.scopeKind,
      scope_id: key.scopeId,
      actor_account_id: key.actorAccountId,
      operation: key.operation,
      command_id: key.commandId,
      request_hash: key.requestHash,
    })
    .execute();
}

export async function completeSharedReceipt(
  trx: Transaction<Database>,
  key: SharedCommandKey,
  outcome: { readonly [key: string]: CanonicalJson },
): Promise<void> {
  const result = await trx
    .updateTable('receipts.shared_commands')
    .set({ outcome: JSON.stringify(outcome) })
    .where('scope_kind', '=', key.scopeKind)
    .where('scope_id', '=', key.scopeId)
    .where('actor_account_id', '=', key.actorAccountId)
    .where('operation', '=', key.operation)
    .where('command_id', '=', key.commandId)
    .where('outcome', 'is', null)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error('Receipt to complete was not pending');
}
