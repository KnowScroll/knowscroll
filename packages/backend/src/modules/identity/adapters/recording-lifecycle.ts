import { sql } from 'kysely';
import { fenceOwnAccount as actualFenceOwnAccount } from './account-access.js';
import type { AccountAccess, FenceOwnAccount, PersonalScopeTx } from '../public.js';
import { recordingTransactionOf } from '../../../infrastructure/postgres/recording-scope.js';
import {
  clearCoreTransactionOf,
  assertCurrentClearRemovalVerified,
} from '../../../infrastructure/postgres/privacy-scope.js';
import { RECORDING_LIFECYCLE_PROTOCOL_SHA256, type ReadRecordingLifecycle, type ClearCoreTx } from '../public.js';
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
    digest: string | null;
  }>`select u.recording_lifecycle_protocol as mode,w.registry_sha256 as digest
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
  if (row.mode === 1 && row.digest === null) return { kind: 'not_ready' };
  return row.mode === 1 && row.digest === RECORDING_LIFECYCLE_PROTOCOL_SHA256
    ? { kind: 'fresh', protocolVersion: 1, registrySha256: RECORDING_LIFECYCLE_PROTOCOL_SHA256 }
    : { kind: 'unavailable' };
};
/** Only the fixed current registry closure can establish the live proof consumed here.
 * The operation core timestamp is already written; the barrier is still held. */
export async function recordClearLifecycle(scope: ClearCoreTx): Promise<void> {
  assertCurrentClearRemovalVerified(scope);
  const b = scope.binding;
  await sql`insert into identity.recording_lifecycle_witnesses(universe_id,privacy_epoch,account_id,protocol_version,origin_kind,clear_operation_id,registry_sha256,verified_at)
 values(${b.universeId}::uuid,${b.toEpoch},${b.accountId}::uuid,1,'clear_core',${b.operationId}::uuid,${RECORDING_LIFECYCLE_PROTOCOL_SHA256},transaction_timestamp())`.execute(
    clearCoreTransactionOf(scope),
  );
}
