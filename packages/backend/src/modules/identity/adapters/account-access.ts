import { sql } from 'kysely';
import { z } from 'zod';
import { revokeAccountSockets } from '../../../infrastructure/notices/index.js';
import { claimAccountFence, transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { AccountLifecyclePorts } from '../application/ports.js';
import type { AccountAccess, FenceAccountPair, FenceOwnAccount, PersonalScopeTx } from '../public.js';

/** The personal root is already held. Read ownership without acquiring any other root. */
async function ownerOf(scope: PersonalScopeTx): Promise<string | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('identity.universes')
    .select('account_id')
    .where('id', '=', scope.authority.universeId)
    .executeTakeFirst();
  if (scope.authority.actor.kind === 'account' && row?.account_id !== scope.authority.actor.accountId) return undefined;
  return row?.account_id;
}

/** Separate post-fence statement: never join universe data into a waiting locking query. */
async function currentAccess(scope: PersonalScopeTx, accountId: string): Promise<AccountAccess | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('identity.accounts as account')
    .innerJoin('identity.universes as universe', 'universe.account_id', 'account.id')
    .select(['account.id as accountId', 'universe.id as universeId', 'universe.privacy_epoch as privacyEpoch'])
    .where('account.id', '=', accountId)
    .where('account.status', '=', 'active')
    .where('universe.status', '=', 'active')
    .executeTakeFirst();
  if (
    row?.accountId === accountId &&
    row.universeId === scope.authority.universeId &&
    row.privacyEpoch !== scope.authority.privacyEpoch
  )
    return undefined;
  return row;
}

export const fenceAccountPair: FenceAccountPair = async (scope, claimedPeer) => {
  claimAccountFence(scope, 'pair');
  const parsed = z.uuid().safeParse(claimedPeer);
  if (!parsed.success) return { kind: 'unavailable' };
  const peerId = parsed.data.toLowerCase();
  const ownerId = await ownerOf(scope);
  if (ownerId === undefined || peerId === ownerId) return { kind: 'unavailable' };
  const trx = transactionOf(scope);
  for (const id of [ownerId, peerId].sort()) {
    const row = await trx
      .selectFrom('identity.accounts')
      .select('id')
      .where('id', '=', id)
      .forShare()
      .executeTakeFirst();
    if (row === undefined) return { kind: 'unavailable' };
  }
  const owner = await currentAccess(scope, ownerId);
  const peer = await currentAccess(scope, peerId);
  if (owner === undefined || owner.universeId !== scope.authority.universeId || peer === undefined)
    return { kind: 'unavailable' };
  return { kind: 'active', owner, peer };
};

export const fenceOwnAccount: FenceOwnAccount = async (scope) => {
  claimAccountFence(scope, 'own');
  const ownerId = await ownerOf(scope);
  if (ownerId === undefined) return { kind: 'unavailable' };
  const row = await transactionOf(scope)
    .selectFrom('identity.accounts')
    .select('id')
    .where('id', '=', ownerId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) return { kind: 'unavailable' };
  const owner = await currentAccess(scope, ownerId);
  return owner === undefined || owner.universeId !== scope.authority.universeId
    ? { kind: 'unavailable' }
    : { kind: 'active', owner };
};

/** Only the lifecycle use case composes this exact effect after its own UPDATE gate. */
export const advanceAccountAccess: AccountLifecyclePorts['advance'] = async (scope, mode) => {
  const trx = transactionOf(scope);
  // The root is locked and the scope authority remains frozen at the previous epoch.
  const row = await trx
    .updateTable('identity.universes')
    .set({ privacy_epoch: sql`privacy_epoch + 1`, revision: sql`revision + 1` })
    .where('id', '=', scope.authority.universeId)
    .returning(['account_id', 'privacy_epoch', 'revision'])
    .executeTakeFirstOrThrow();
  if (mode === 'suspend')
    await trx.updateTable('identity.accounts').set({ status: 'suspended' }).where('id', '=', row.account_id).execute();
  await revokeAccountSockets(trx, row.account_id);
  return { kind: 'invalidated', privacyEpoch: row.privacy_epoch, revision: row.revision };
};
