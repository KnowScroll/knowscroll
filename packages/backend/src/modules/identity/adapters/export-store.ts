import { sql, type Kysely, type Selectable } from 'kysely';
import type { EnqueueJob } from '../../../infrastructure/jobs/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { transactionOf, withTransaction } from '../../../infrastructure/postgres/personal-scope.js';
import {
  EXPORTS_KEPT,
  EXPORT_AVAILABLE_DAYS,
  EXPORT_LINK_SECONDS,
  type DataExportPorts,
} from '../application/data-export.js';
import { buildDataExportQueue } from '../events.js';
import type { DataExportState, DataExportSummary } from '../public.js';

type ExportRow = Pick<Selectable<Database['identity.data_exports']>, 'id' | 'state' | 'requested_at' | 'expires_at'>;

const summaryColumns = ['id', 'state', 'requested_at', 'expires_at'] as const;

/** A ready export whose time has passed reads as expired before the sweep gets to it. */
function summarize(row: ExportRow): DataExportSummary {
  const lapsed = row.state === 'ready' && row.expires_at !== null && row.expires_at.getTime() <= Date.now();
  return {
    id: row.id,
    state: lapsed ? 'expired' : (row.state as DataExportState),
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
  };
}

/** The SQL behind personal data export. Every method that takes a scope runs in its transaction. */
export function exportStore(deps: {
  readonly db: Kysely<Database>;
  readonly enqueueJob: EnqueueJob;
}): Omit<DataExportPorts, 'withScope' | 'secrets' | 'gather'> {
  const { db } = deps;
  return {
    async create(scope, accountId, exportId) {
      const trx = transactionOf(scope);
      const existing = await trx
        .selectFrom('identity.data_exports')
        .select([...summaryColumns, 'account_id'])
        .where('id', '=', exportId)
        .executeTakeFirst();
      if (existing !== undefined)
        return existing.account_id === accountId
          ? { kind: 'replayed', export: summarize(existing) }
          : { kind: 'id_in_use' };
      const inFlight = await trx
        .selectFrom('identity.data_exports')
        .select(summaryColumns)
        .where('account_id', '=', accountId)
        .where('state', '=', 'preparing')
        .orderBy('requested_at', 'desc')
        .executeTakeFirst();
      if (inFlight !== undefined) return { kind: 'in_flight', export: summarize(inFlight) };
      // Room for the new one: the oldest beyond the newest few go, file and receipt.
      await trx
        .deleteFrom('identity.data_exports')
        .where('account_id', '=', accountId)
        .where(
          'id',
          'not in',
          trx
            .selectFrom('identity.data_exports')
            .select('id')
            .where('account_id', '=', accountId)
            .orderBy('requested_at', 'desc')
            .limit(EXPORTS_KEPT - 1),
        )
        .execute();
      const created = await trx
        .insertInto('identity.data_exports')
        .values({ id: exportId, account_id: accountId })
        .returning(summaryColumns)
        .executeTakeFirstOrThrow();
      return { kind: 'created', export: summarize(created) };
    },

    async list(scope, accountId) {
      const rows = await transactionOf(scope)
        .selectFrom('identity.data_exports')
        .select(summaryColumns)
        .where('account_id', '=', accountId)
        .orderBy('requested_at', 'desc')
        .limit(EXPORTS_KEPT)
        .execute();
      return rows.map(summarize);
    },

    async mintLink(scope, accountId, exportId, linkHash) {
      const trx = transactionOf(scope);
      const row = await trx
        .selectFrom('identity.data_exports')
        .select(['state', sql<boolean>`expires_at > now()`.as('live')])
        .where('id', '=', exportId)
        .where('account_id', '=', accountId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return { kind: 'not_found' };
      if (row.state !== 'ready' || !row.live) return { kind: 'not_ready' };
      const minted = await trx
        .updateTable('identity.data_exports')
        .set({
          link_hash: linkHash,
          link_expires_at: sql<Date>`now() + make_interval(secs => ${EXPORT_LINK_SECONDS})`,
        })
        .where('id', '=', exportId)
        .returning('link_expires_at')
        .executeTakeFirstOrThrow();
      if (minted.link_expires_at === null) throw new Error('EXPORT_LINK_NOT_STORED');
      return { kind: 'minted', expiresAt: minted.link_expires_at };
    },

    enqueue: (scope, exportId) => deps.enqueueJob(scope, buildDataExportQueue, { v: 1, exportId }),

    consume: (linkHash) =>
      withTransaction(db, 'identity.consume-export-link', async (trx) => {
        const row = await trx
          .selectFrom('identity.data_exports as entry')
          .innerJoin('identity.accounts as account', 'account.id', 'entry.account_id')
          .select(['entry.id', 'entry.payload'])
          .where('entry.link_hash', '=', linkHash)
          .where('entry.link_expires_at', '>', sql<Date>`now()`)
          .where('entry.state', '=', 'ready')
          .where('account.status', '=', 'active')
          // Only the export row is locked: the account row is read, never held.
          .modifyEnd(sql`for update of entry`)
          .executeTakeFirst();
        if (row === undefined || row.payload === null) return undefined;
        await trx
          .updateTable('identity.data_exports')
          .set({
            state: 'downloaded',
            downloaded_at: sql<Date>`now()`,
            payload: null,
            link_hash: null,
            link_expires_at: null,
          })
          .where('id', '=', row.id)
          .execute();
        return new Uint8Array(row.payload);
      }),

    async readBuildTarget(exportId) {
      const row = await db
        .selectFrom('identity.data_exports as entry')
        .innerJoin('identity.universes as universe', 'universe.account_id', 'entry.account_id')
        .select(['entry.account_id', 'universe.id as universe_id', 'universe.privacy_epoch'])
        .where('entry.id', '=', exportId)
        .where('entry.state', '=', 'preparing')
        .executeTakeFirst();
      return row === undefined
        ? undefined
        : { accountId: row.account_id, universeId: row.universe_id, privacyEpoch: row.privacy_epoch };
    },

    async lockPreparing(scope, exportId) {
      const row = await transactionOf(scope)
        .selectFrom('identity.data_exports')
        .select('id')
        .where('id', '=', exportId)
        .where('state', '=', 'preparing')
        .forUpdate()
        .executeTakeFirst();
      return row !== undefined;
    },

    async storeReady(scope, exportId, file) {
      await transactionOf(scope)
        .updateTable('identity.data_exports')
        .set({
          state: 'ready',
          payload: Buffer.from(file),
          ready_at: sql<Date>`now()`,
          expires_at: sql<Date>`now() + make_interval(days => ${EXPORT_AVAILABLE_DAYS})`,
        })
        .where('id', '=', exportId)
        .execute();
    },

    async markFailedIn(scope, exportId) {
      await transactionOf(scope)
        .updateTable('identity.data_exports')
        .set({ state: 'failed' })
        .where('id', '=', exportId)
        .execute();
    },

    async markFailed(exportId) {
      await db
        .updateTable('identity.data_exports')
        .set({ state: 'failed' })
        .where('id', '=', exportId)
        .where('state', '=', 'preparing')
        .execute();
    },
  };
}
