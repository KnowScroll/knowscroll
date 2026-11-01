import { uuidv7 } from '../../../infrastructure/ids/index.js';
import { sql, type Kysely } from 'kysely';
import type { PersonalAuthority, PersonalScopeTx } from '../../identity/public.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf } from '../../../infrastructure/postgres/personal-scope.js';
import { readPersonalRecordingNow } from '../../../infrastructure/postgres/recording-scope.js';
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
        saved_entry_id: uuidv7(),
      })
      .onConflict((conflict) => conflict.columns(['universe_id', 'asset_id']).doNothing())
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
    .select(['id', 'command_id', 'kind', 'asset_id', 'asset_revision', 'privacy_epoch'])
    .where('universe_id', '=', scope.authority.universeId)
    .where('id', '=', actionId)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const origins = await sql<{
    original_generation: number | null;
    eligible_generation: number | null;
  }>`select o.original_generation,o.eligible_generation from experience.actions a join experience.recording_command_origins o on o.universe_id=a.universe_id and o.command_id=a.command_id and o.privacy_epoch=a.privacy_epoch where a.universe_id=${scope.authority.universeId}::uuid and a.privacy_epoch=${scope.authority.privacyEpoch} and a.id=${row.id}::uuid`.execute(
    transactionOf(scope),
  );
  const origin = origins.rows[0]
    ? {
        original: origins.rows[0].original_generation ?? undefined,
        eligible: origins.rows[0].eligible_generation ?? undefined,
      }
    : undefined;
  return {
    recordingOrigin: origin
      ? {
          kind: 'recorded',
          ...(origin.original === undefined ? {} : { originalGeneration: origin.original }),
          ...(origin.eligible === undefined ? {} : { eligibleGeneration: origin.eligible }),
        }
      : { kind: 'legacy' },
    id: row.id,
    commandId: row.command_id,
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

/**
 * Whether recording is not collecting right now, read under the root the caller holds. Every exposure is written through
 * `insertExposure` and `markExposureActivated`, so the rule that an exposure made while recording is paused is marked
 * (D-284) lives here and cannot be skipped by a new way of opening an item.
 */
async function recordingNotCollecting(scope: PersonalScopeTx): Promise<boolean> {
  return (await readPersonalRecordingNow(scope)).kind !== 'recording';
}

/**
 * Inserts one exposure inside the locked scope (with the open command's receipt). The exposure is marked
 * `made_while_paused` when recording is paused now: it still serves its item, and History leaves it out.
 */
export async function insertExposure(scope: PersonalScopeTx, exposure: NewExposure): Promise<void> {
  const madeWhilePaused = await recordingNotCollecting(scope);
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
      made_while_paused: madeWhilePaused,
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

/**
 * Sets the activation time once, inside the locked scope. A second call changes nothing. An exposure opened with
 * recording on but activated while it is paused is marked `made_while_paused`; the mark is never taken back.
 */
export async function markExposureActivated(scope: PersonalScopeTx, exposureId: string, at: Date): Promise<void> {
  const pausedNow = await recordingNotCollecting(scope);
  await transactionOf(scope)
    .updateTable('experience.exposures')
    .set({ activated_at: at, made_while_paused: sql<boolean>`made_while_paused or ${pausedNow}` })
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
