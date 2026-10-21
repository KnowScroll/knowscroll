import { createHash } from 'node:crypto';
import { PublicPersonRefSchema } from '@knowscroll/contracts';
import type { PersonalScopeTx } from '../../identity/public.js';
import {
  enterSharedRoot,
  sharedTransactionOf,
  transactionOf,
} from '../../../infrastructure/postgres/personal-scope.js';
import {
  completePersonalReceipt,
  completeSharedReceipt,
  findPersonalReceipt,
  findSharedReceipt,
  insertPersonalReceipt,
  insertSharedReceipt,
  type CanonicalJson,
} from '../../../infrastructure/receipts/index.js';
import type { Binding, PairLock, Profile, SocialStore } from '../application/ports.js';
import type { Side, Window } from '../domain/friends.js';
/** Versioned canonical PRIVATE pair identity. Not a public identity or an authority token.
 * Every acquisition verifies BOTH the UUID and ordered account binding; collisions fail closed. */
export function privatePairId(a: string, b: string): string {
  const [low, high] = [a.toLowerCase(), b.toLowerCase()].sort();
  if (low === high) throw new Error('SOCIAL_PAIR_BINDING');
  const bytes = createHash('sha256').update(`social.pair.v1\0${low}\0${high}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const trxOf = (scope: PersonalScopeTx | PairLock) =>
  'shared' in scope ? sharedTransactionOf(scope.shared) : transactionOf(scope);
export const socialStore: SocialStore = {
  async profile(scope, by) {
    let query = transactionOf(scope).selectFrom('social.profiles').selectAll();
    if ('accountId' in by) query = query.where('account_id', '=', by.accountId);
    else if ('personId' in by) query = query.where('person_id', '=', by.personId);
    else query = query.where('handle', '=', by.handle);
    const row = await query.executeTakeFirst();
    if (!row) return undefined;
    return {
      accountId: row.account_id,
      revision: Number(row.profile_revision),
      person: PublicPersonRefSchema.parse({
        kind: 'person',
        personId: row.person_id,
        handle: row.handle,
        displayName: row.display_name,
      }),
    };
  },
  async saveProfile(scope, profile: Profile) {
    try {
      await transactionOf(scope)
        .insertInto('social.profiles')
        .values({
          account_id: profile.accountId,
          person_id: profile.person.personId,
          handle: profile.person.handle,
          display_name: profile.person.displayName,
          profile_revision: profile.revision,
        })
        .onConflict((oc) =>
          oc.column('account_id').doUpdateSet({
            handle: profile.person.handle,
            display_name: profile.person.displayName,
            profile_revision: profile.revision,
          }),
        )
        .execute();
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        throw new Error('SOCIAL_HANDLE_TAKEN', { cause: error });
      throw error;
    }
  },
  async lockPair(scope, actor, peer, create) {
    const [low, high] = [actor, peer].sort(),
      id = privatePairId(actor, peer);
    const shared = await enterSharedRoot(scope, {
      kind: 'social_pair',
      id,
      lock: async (trx) => {
        if (create) {
          await trx
            .insertInto('social.pairs')
            .values({ pair_id: id, low_account_id: low!, high_account_id: high! })
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
        const row = await trx
          .selectFrom('social.pairs')
          .select(['low_account_id', 'high_account_id'])
          .where('pair_id', '=', id)
          .forUpdate()
          .executeTakeFirst();
        if (!row) {
          if (create) throw new Error('SOCIAL_PAIR_BINDING');
          return false;
        }
        if (row.low_account_id !== low || row.high_account_id !== high) throw new Error('SOCIAL_PAIR_BINDING');
        if (create)
          for (const accountId of [low, high])
            await trx
              .insertInto('social.pair_sides')
              .values({ pair_id: id, account_id: accountId })
              .onConflict((oc) => oc.doNothing())
              .execute();
        return true;
      },
    });
    if (!shared) return undefined;
    const trx = sharedTransactionOf(shared);
    const row = await trx.selectFrom('social.pairs').selectAll().where('pair_id', '=', id).executeTakeFirstOrThrow();
    const sides: Side[] = (
      await trx.selectFrom('social.pair_sides').selectAll().where('pair_id', '=', id).orderBy('account_id').execute()
    ).map((s) => ({
      accountId: s.account_id,
      blocked: s.own_blocked,
      revision: Number(s.public_revision),
      state: s.public_state as Side['state'],
    }));
    if (sides.length !== 2 || sides[0]!.accountId !== low || sides[1]!.accountId !== high)
      throw new Error('SOCIAL_PAIR_BINDING');
    const request = row.current_request_id
      ? await trx
          .selectFrom('social.requests')
          .selectAll()
          .where('request_id', '=', row.current_request_id)
          .where('pair_id', '=', id)
          .executeTakeFirstOrThrow()
      : undefined;
    const window: Window | null = request
      ? {
          id: request.request_id,
          sender: request.sender_account_id,
          recipient: request.recipient_account_id,
          expiresAt: new Date(request.expires_at).getTime(),
          disposition: request.disposition as Window['disposition'],
        }
      : null;
    return {
      shared,
      pair: {
        id,
        low: low,
        high: high,
        privateRevision: Number(row.private_revision),
        lineage: row.accepted_lineage,
        window,
        sides: [sides[0]!, sides[1]!],
      },
    };
  },
  async savePair(lock, pair) {
    const trx = sharedTransactionOf(lock.shared);
    if (pair.id !== lock.shared.root.id) throw new Error('SOCIAL_PAIR_BINDING');
    if (pair.window) {
      const w = pair.window;
      const old = await trx.selectFrom('social.requests').selectAll().where('request_id', '=', w.id).executeTakeFirst();
      if (old) {
        if (
          old.pair_id !== pair.id ||
          old.sender_account_id !== w.sender ||
          old.recipient_account_id !== w.recipient ||
          new Date(old.expires_at).getTime() !== w.expiresAt
        )
          throw new Error('SOCIAL_REQUEST_BINDING');
        await trx
          .updateTable('social.requests')
          .set({ disposition: w.disposition })
          .where('request_id', '=', w.id)
          .execute();
      } else
        await trx
          .insertInto('social.requests')
          .values({
            request_id: w.id,
            pair_id: pair.id,
            sender_account_id: w.sender,
            recipient_account_id: w.recipient,
            expires_at: new Date(w.expiresAt),
            disposition: w.disposition,
          })
          .execute();
    }
    await trx
      .updateTable('social.pairs')
      .set({
        private_revision: pair.privateRevision,
        current_request_id: pair.window?.id ?? null,
        accepted_lineage: pair.lineage,
      })
      .where('pair_id', '=', pair.id)
      .execute();
    for (const s of pair.sides)
      await trx
        .updateTable('social.pair_sides')
        .set({ own_blocked: s.blocked, public_revision: s.revision, public_state: s.state })
        .where('pair_id', '=', pair.id)
        .where('account_id', '=', s.accountId)
        .execute();
  },
  async binding(lock, actor, operation, command) {
    const row = await sharedTransactionOf(lock.shared)
      .selectFrom('social.command_bindings')
      .select(['actor_epoch', 'lineage'])
      .where('pair_id', '=', lock.shared.root.id)
      .where('actor_account_id', '=', actor)
      .where('operation', '=', operation)
      .where('command_id', '=', command)
      .executeTakeFirst();
    return row ? { epoch: row.actor_epoch, lineage: row.lineage } : undefined;
  },
  async bind(lock, actor, operation, command, binding: Binding) {
    await sharedTransactionOf(lock.shared)
      .insertInto('social.command_bindings')
      .values({
        pair_id: lock.shared.root.id,
        actor_account_id: actor,
        operation,
        command_id: command,
        actor_epoch: binding.epoch,
        lineage: binding.lineage,
      })
      .execute();
  },
  async findReceipt(scope, key) {
    trxOf(scope); // asserts open capability before accessing receipt helpers
    const found =
      'shared' in scope ? await findSharedReceipt(scope.shared, key) : await findPersonalReceipt(scope, key);
    return found.kind === 'new' || found.kind === 'replay'
      ? found
      : { kind: 'refused', code: found.kind === 'key_reused' ? 'command_key_reused' : 'unavailable' };
  },
  async beginReceipt(scope, key) {
    if ('shared' in scope) await insertSharedReceipt(scope.shared, key);
    else await insertPersonalReceipt(scope, key);
  },
  async receipt(scope, key, outcome) {
    const value = outcome as { readonly [key: string]: CanonicalJson };
    if ('shared' in scope) {
      await completeSharedReceipt(scope.shared, key, value);
    } else {
      await completePersonalReceipt(scope, key.commandId, value);
    }
  },
};
