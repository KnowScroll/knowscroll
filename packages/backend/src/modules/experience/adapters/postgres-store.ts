import type { Kysely } from 'kysely';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import type { SavedState } from '../domain/actions.js';
import type { Exposure, ExposureKind } from '../domain/exposures.js';
import type { ActionRecord, NewExposure, ReadExposureDocumentPorts } from '../application/ports.js';
import type { ActionForEvidence, ExposureForEvidence } from '../public.js';

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
    kind: row.kind as ActionForEvidence['kind'],
    assetId: row.asset_id,
    assetRevision: row.asset_revision,
    privacyEpoch: row.privacy_epoch,
  };
}

/** Maps a stored exposure row to the domain's `Exposure`. */
function exposureOf(row: {
  readonly id: string;
  readonly asset_id: string;
  readonly asset_revision: number;
  readonly kind: string;
  readonly origin: string;
  readonly opened_at: Date | string;
  readonly activated_at: Date | string | null;
  readonly privacy_epoch: number;
}): Exposure {
  return {
    id: row.id,
    assetId: row.asset_id,
    assetRevision: row.asset_revision,
    kind: row.kind as ExposureKind,
    origin: row.origin,
    openedAt: new Date(row.opened_at),
    activatedAt: row.activated_at === null ? undefined : new Date(row.activated_at),
    privacyEpoch: row.privacy_epoch,
  };
}

/** Inserts one exposure inside the locked scope (with the open command's receipt). */
export async function insertExposure(scope: PersonalScopeTx, exposure: NewExposure): Promise<void> {
  await transactionOf(scope)
    .insertInto('experience.exposures')
    .values({
      universe_id: scope.authority.universeId,
      id: exposure.id,
      asset_id: exposure.assetId,
      asset_revision: exposure.assetRevision,
      kind: exposure.kind,
      origin: exposure.origin,
      capabilities: JSON.stringify(exposure.capabilities),
      command_id: exposure.commandId,
      privacy_epoch: scope.authority.privacyEpoch,
      opened_at: exposure.openedAt,
    })
    .execute();
}

/** Reads one exposure of the scope's universe inside the locked scope. */
export async function readExposure(scope: PersonalScopeTx, exposureId: string): Promise<Exposure | undefined> {
  const row = await transactionOf(scope)
    .selectFrom('experience.exposures')
    .select(['id', 'asset_id', 'asset_revision', 'kind', 'origin', 'opened_at', 'activated_at', 'privacy_epoch'])
    .where('universe_id', '=', scope.authority.universeId)
    .where('id', '=', exposureId)
    .executeTakeFirst();
  return row === undefined ? undefined : exposureOf(row);
}

/** Sets the activation time once, inside the locked scope. A second call changes nothing. */
export async function markExposureActivated(scope: PersonalScopeTx, exposureId: string, at: Date): Promise<void> {
  await transactionOf(scope)
    .updateTable('experience.exposures')
    .set({ activated_at: at })
    .where('universe_id', '=', scope.authority.universeId)
    .where('id', '=', exposureId)
    .where('activated_at', 'is', null)
    .execute();
}

/** Reads one exposure for the evidence module's lineage checks (inside the reader's own locked scope). */
export async function readExposureForEvidence(
  scope: PersonalScopeTx,
  exposureId: string,
): Promise<ExposureForEvidence | undefined> {
  const exposure = await readExposure(scope, exposureId);
  if (exposure === undefined) return undefined;
  return {
    id: exposure.id,
    assetId: exposure.assetId,
    assetRevision: exposure.assetRevision,
    kind: exposure.kind,
    openedAt: exposure.openedAt,
    activatedAt: exposure.activatedAt,
    privacyEpoch: exposure.privacyEpoch,
  };
}

/**
 * The document read: one statement that rechecks the universe's status, epoch and owner and reads
 * the exposure's lineage and declared capabilities. No lock, so reads never wait behind commands.
 */
export function makeReadExposureForDocument(db: Kysely<Database>): ReadExposureDocumentPorts['readExposure'] {
  return async (authority: PersonalAuthority, exposureId: string) => {
    const universe = await db
      .selectFrom('identity.universes as universe')
      .innerJoin('identity.accounts as account', 'account.id', 'universe.account_id')
      .select(['universe.privacy_epoch', 'universe.status', 'universe.account_id', 'account.status as account_status'])
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
    const row = await db
      .selectFrom('experience.exposures')
      .select(['id', 'asset_id', 'asset_revision', 'capabilities'])
      .where('universe_id', '=', authority.universeId)
      .where('id', '=', exposureId)
      .where('privacy_epoch', '=', authority.privacyEpoch)
      .executeTakeFirst();
    if (row === undefined) return { kind: 'refused', reason: 'exposure_not_found' };
    return {
      kind: 'read',
      exposure: {
        id: row.id,
        assetId: row.asset_id,
        assetRevision: row.asset_revision,
        capabilities: row.capabilities,
      },
    };
  };
}
