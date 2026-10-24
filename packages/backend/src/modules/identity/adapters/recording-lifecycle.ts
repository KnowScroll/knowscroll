import { sql } from 'kysely';
import { fenceOwnAccount as actualFenceOwnAccount } from './account-access.js';
import type { AccountAccess, FenceOwnAccount, PersonalScopeTx } from '../public.js';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import {
  clearCoreTransactionOf,
  assertCurrentClearRemovalVerified,
} from '../../../infrastructure/postgres/privacy-scope.js';
import type { ReadRecordingLifecycle, ClearCoreTx } from '../public.js';
const ownSnapshots = new WeakMap<PersonalScopeTx, Readonly<AccountAccess>>();
/** Exactly the existing real own UPDATE, with a private success brand for lifecycle reads. */
export const fenceOwnRecordingLifecycle: FenceOwnAccount = async (scope) => {
  const result = await actualFenceOwnAccount(scope);
  if (result.kind === 'active') ownSnapshots.set(scope, Object.freeze({ ...result.owner }));
  return result;
};
/** No root/account lock is acquired here. The caller already holds both and original generation. */
export const readRecordingLifecycle: ReadRecordingLifecycle = async (scope) => {
  const db = recordingTransactionOf(scope),
    p = scope.personal;
  const owner = ownSnapshots.get(p);
  if (!owner || owner.universeId !== p.authority.universeId || owner.privacyEpoch !== p.authority.privacyEpoch)
    return { kind: 'unavailable' };
  const result = await sql<{
    mode: number | null;
    witnessed: boolean;
  }>`select u.recording_lifecycle_protocol as mode,w.universe_id is not null as witnessed
 from identity.universes u join identity.accounts a on a.id=u.account_id
 left join identity.recording_lifecycle_witnesses w on w.universe_id=u.id and w.privacy_epoch=u.privacy_epoch
  and w.account_id=u.account_id and w.protocol_version=1
 where u.id=${p.authority.universeId}::uuid and u.account_id=${owner.accountId}::uuid and u.privacy_epoch=${p.authority.privacyEpoch}
 and u.recording_generation=${scope.generation} and u.recording_on and u.status='active' and a.status='active'
 and u.clear_operation_id is null and (${p.authority.actor.kind === 'account' ? p.authority.actor.accountId : null}::uuid is null
  or u.account_id=${p.authority.actor.kind === 'account' ? p.authority.actor.accountId : null}::uuid)`.execute(db);
  const row = result.rows[0];
  if (!row) return { kind: 'unavailable' };
  if (row.mode === null) return { kind: 'legacy_unknown' };
  return row.witnessed ? { kind: 'fresh', protocolVersion: 1 } : { kind: 'not_ready' };
};
/**
 * Installs the witness of the new epoch at the end of a selective Clear. Only the real erasure
 * registry's runner can establish the proof asserted here. The operation's core timestamp is
 * already written and the barrier is still held, so a failure rolls the whole Clear back.
 */
export async function recordClearLifecycle(scope: ClearCoreTx): Promise<void> {
  assertCurrentClearRemovalVerified(scope);
  const b = scope.binding;
  await sql`insert into identity.recording_lifecycle_witnesses(universe_id,privacy_epoch,account_id,protocol_version,origin_kind,clear_operation_id,verified_at)
 values(${b.universeId}::uuid,${b.toEpoch},${b.accountId}::uuid,1,'clear_core',${b.operationId}::uuid,transaction_timestamp())`.execute(
    clearCoreTransactionOf(scope),
  );
}
