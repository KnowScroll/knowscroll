import type { PersonalScopeTx } from '../../modules/identity/public.js';
import { transactionOf } from '../postgres/personal-scope.js';
import type { CanonicalJson } from './canonical.js';

/** Identity of a personal command: the universe comes from the scope, never from the client. */
export interface PersonalCommandKey {
  readonly commandId: string;
  /** `<module>.<operation>`, e.g. `experience.apply-action`. */
  readonly operation: string;
  /** `requestHash(operation, validatedRequest)`. */
  readonly requestHash: string;
}

/** What the receipt table says about a command key, read under the scope lock. */
export type ReceiptLookup =
  { readonly kind: 'new' } | { readonly kind: 'replay'; readonly outcome: unknown } | { readonly kind: 'key_reused' };

/**
 * Looks up `(universe_id, command_id)` inside the locked personal scope (blueprint §19 step 2).
 * `replay` carries the stored outcome of an identical request; `key_reused` means the same key
 * arrived with a different operation or request hash (→ `COMMAND_KEY_REUSED`, 422). Read-only.
 */
export async function findPersonalReceipt(scope: PersonalScopeTx, key: PersonalCommandKey): Promise<ReceiptLookup> {
  const existing = await transactionOf(scope)
    .selectFrom('receipts.personal_commands')
    .select(['operation', 'request_hash', 'outcome'])
    .where('universe_id', '=', scope.authority.universeId)
    .where('command_id', '=', key.commandId)
    .executeTakeFirst();
  if (existing === undefined) return { kind: 'new' };
  if (existing.operation !== key.operation || existing.request_hash !== key.requestHash) return { kind: 'key_reused' };
  if (existing.outcome === null) throw new Error('Receipt without outcome outside its own transaction');
  return { kind: 'replay', outcome: existing.outcome };
}

/**
 * Inserts the pending receipt before the command's effects (blueprint §19 step 3). The personal
 * lock serialises callers for one universe; the primary key still refuses a second insert from a
 * writer that skipped the lock. Side effect: one row, committed only with the effects.
 */
export async function insertPersonalReceipt(scope: PersonalScopeTx, key: PersonalCommandKey): Promise<void> {
  await transactionOf(scope)
    .insertInto('receipts.personal_commands')
    .values({
      universe_id: scope.authority.universeId,
      command_id: key.commandId,
      operation: key.operation,
      request_hash: key.requestHash,
      privacy_epoch: scope.authority.privacyEpoch,
    })
    .execute();
}

/** Stores the outcome on the pending receipt, in the same transaction as the effects (step 4). */
export async function completePersonalReceipt(
  scope: PersonalScopeTx,
  commandId: string,
  outcome: { readonly [key: string]: CanonicalJson },
): Promise<void> {
  const result = await transactionOf(scope)
    .updateTable('receipts.personal_commands')
    .set({ outcome: JSON.stringify(outcome) })
    .where('universe_id', '=', scope.authority.universeId)
    .where('command_id', '=', commandId)
    .where('outcome', 'is', null)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error('Receipt to complete was not pending');
}
