import type { Transaction } from 'kysely';
import type { FencePersonalRecording, RecordingScopeTx, PersonalScopeTx } from '../../modules/identity/public.js';
import type { Database } from './database.js';
import { transactionOf, ScopeClosedError } from './personal-scope.js';
const open = new WeakMap<RecordingScopeTx, PersonalScopeTx>();
/** Additive opt-in gate for NEW personal contributions. Necessary commands keep PersonalScopeTx.
 * Already-held root prevents a toggle/Clear racing the check and ensuing same-transaction effect.
 * No account gate upgrade, peer root, persistent lease or external effect permission is added. */
export const fencePersonalRecording: FencePersonalRecording = async (personal, originalGeneration) => {
  const row = await transactionOf(personal)
    .selectFrom('identity.universes as u')
    .innerJoin('identity.accounts as a', 'a.id', 'u.account_id')
    .select([
      'u.account_id',
      'u.privacy_epoch',
      'u.status',
      'u.clear_operation_id',
      'u.recording_on',
      'u.recording_generation',
      'a.status as account_status',
    ])
    .where('u.id', '=', personal.authority.universeId)
    .executeTakeFirst();
  if (
    !row ||
    row.status !== 'active' ||
    row.account_status !== 'active' ||
    row.clear_operation_id !== null ||
    row.privacy_epoch !== personal.authority.privacyEpoch ||
    (personal.authority.actor.kind === 'account' && row.account_id !== personal.authority.actor.accountId)
  )
    return { kind: 'unavailable' };
  if (originalGeneration === undefined && row.recording_generation !== 1) return { kind: 'generation_required' };
  if (!row.recording_on) return { kind: 'paused', currentGeneration: row.recording_generation };
  const generation = originalGeneration ?? 1;
  if (
    !Number.isInteger(generation) ||
    generation < 1 ||
    generation > 2_147_483_647 ||
    generation !== row.recording_generation
  )
    return { kind: 'stale', currentGeneration: row.recording_generation };
  const scope = Object.freeze({ personal, generation }) as unknown as RecordingScopeTx;
  open.set(scope, personal);
  return { kind: 'recording', scope };
};
/** Runtime provenance and the existing personal capability lifetime, not structural typing. */
export function recordingTransactionOf(scope: RecordingScopeTx): Transaction<Database> {
  const personal = open.get(scope);
  if (!personal) throw new ScopeClosedError('Recording capability is not genuine or has ended');
  return transactionOf(personal);
}
