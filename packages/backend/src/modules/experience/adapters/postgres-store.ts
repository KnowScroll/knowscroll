import type { Kysely } from 'kysely';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { ActionKind, SavedState } from '../domain/actions.js';
import type { ActionRecord, ListSavedPorts } from '../application/ports.js';

/** Saved state of one asset, read inside the locked scope. */
export async function readSavedState(scope: PersonalScopeTx, assetId: string): Promise<SavedState> {
  const row = await transactionOf(scope)
    .selectFrom('experience.saved_items')
    .select('asset_id')
    .where('universe_id', '=', scope.authority.universeId)
    .where('asset_id', '=', assetId)
    .executeTakeFirst();
  return { saved: row !== undefined };
}

/** Adds or removes one saved item inside the locked scope. */
export async function writeSavedState(
  scope: PersonalScopeTx,
  change: { readonly assetId: string; readonly assetRevision: number; readonly saved: boolean; readonly at: Date },
): Promise<void> {
  const trx = transactionOf(scope);
  if (change.saved) {
    await trx
      .insertInto('experience.saved_items')
      .values({
        universe_id: scope.authority.universeId,
        asset_id: change.assetId,
        asset_revision: change.assetRevision,
        saved_at: change.at,
      })
      .onConflict((conflict) =>
        conflict
          .columns(['universe_id', 'asset_id'])
          .doUpdateSet({ asset_revision: change.assetRevision, saved_at: change.at }),
      )
      .execute();
  } else {
    await trx
      .deleteFrom('experience.saved_items')
      .where('universe_id', '=', scope.authority.universeId)
      .where('asset_id', '=', change.assetId)
      .execute();
  }
}

/** Records one accepted action inside the locked scope. */
export async function recordAction(scope: PersonalScopeTx, action: ActionRecord): Promise<void> {
  await transactionOf(scope)
    .insertInto('experience.actions')
    .values({
      universe_id: scope.authority.universeId,
      id: action.id,
      command_id: action.commandId,
      kind: action.kind,
      asset_id: action.assetId,
      asset_revision: action.assetRevision,
      privacy_epoch: scope.authority.privacyEpoch,
      created_at: action.at,
    })
    .execute();
}

/** An action as the evidence module reads it. */
export interface ActionForEvidence {
  readonly id: string;
  readonly kind: ActionKind;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly privacyEpoch: number;
}

/**
 * Reads one action of the scope's universe for the evidence job (inside the job's own locked
 * scope). `undefined` when the action no longer exists (erased).
 */
export async function readActionForEvidence(
  scope: PersonalScopeTx,
  actionId: string,
): Promise<ActionForEvidence | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('experience.actions')
    .select(['id', 'kind', 'asset_id', 'asset_revision', 'privacy_epoch'])
    .where('universe_id', '=', scope.authority.universeId)
    .where('id', '=', actionId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  return {
    id: row.id,
    kind: row.kind as ActionKind,
    assetId: row.asset_id,
    assetRevision: row.asset_revision,
    privacyEpoch: row.privacy_epoch,
  };
}

/**
 * The saved-items read: one statement that rechecks the universe's status, epoch and owner and
 * reads a bounded page, newest first. No lock, so reads never wait behind commands.
 */
export function makeReadSavedItems(db: Kysely<Database>): ListSavedPorts['readSavedItems'] {
  return async (authority: PersonalAuthority, limit: number) => {
    const universe = await db
      .selectFrom('identity.universes as universe')
      .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
      .select([
        'universe.privacy_epoch',
        'universe.status',
        'universe.revision',
        'universe.account_id',
        'account.status as account_status',
      ])
      .where('universe.id', '=', authority.universeId)
      .executeTakeFirst();
    const ownerMatches = authority.actor.kind !== 'account' || universe?.account_id === authority.actor.accountId;
    if (
      universe === undefined ||
      universe.status !== 'active' ||
      universe.account_status !== 'active' ||
      !ownerMatches
    ) {
      return { kind: 'refused', reason: 'universe_unavailable' };
    }
    if (universe.privacy_epoch !== authority.privacyEpoch) return { kind: 'refused', reason: 'epoch_changed' };
    const rows = await db
      .selectFrom('experience.saved_items')
      .select(['asset_id', 'asset_revision', 'saved_at'])
      .where('universe_id', '=', authority.universeId)
      .orderBy('saved_at', 'desc')
      .orderBy('asset_id')
      .limit(limit)
      .execute();
    return {
      kind: 'read',
      revision: universe.revision,
      items: rows.map((row) => ({ assetId: row.asset_id, assetRevision: row.asset_revision, savedAt: row.saved_at })),
    };
  };
}
