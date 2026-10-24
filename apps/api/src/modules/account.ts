import type { Kysely } from 'kysely';
import type { createBoss } from '@knowscroll/backend/infrastructure/jobs';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { Database } from '@knowscroll/backend/infrastructure/postgres';
import { eraseCurrentAccount, exportCurrentPerson } from '@knowscroll/backend/erasure-registry';
import { CHECK_ASSET_AUDIENCE, type CheckAssetAudience } from '@knowscroll/backend/modules/content';
import { CONSUME_DATA_EXPORT_LINK, type ConsumeDataExportLink } from '@knowscroll/backend/modules/identity';
import { dataExportFor, deleteAccountFor } from '@knowscroll/backend/modules/identity/nest-providers';
import { API_CONFIG, DATABASE, PG_BOSS } from '../tokens.js';

export const DELETE_ACCOUNT = Symbol('account.delete');
export const DATA_EXPORT = Symbol('account.dataExport');
export type DeleteAccountUseCases = ReturnType<typeof deleteAccountFor>;
export type DataExportUseCases = ReturnType<typeof dataExportFor>;

/**
 * Account deletion and export for the API. The API only accepts durable work: the erasure and the
 * file build run in the worker, never in a request.
 */
export const accountWiring = [
  {
    provide: DELETE_ACCOUNT,
    inject: [DATABASE, PG_BOSS, API_CONFIG],
    useFactory: (db: Kysely<Database>, boss: ReturnType<typeof createBoss>, config: ApiConfig): DeleteAccountUseCases =>
      deleteAccountFor(db, boss, {
        eraseAccountData: eraseCurrentAccount,
        lockTimeoutMs: config.scopeLockTimeoutMs,
      }),
  },
  {
    provide: DATA_EXPORT,
    inject: [DATABASE, PG_BOSS, API_CONFIG, CHECK_ASSET_AUDIENCE],
    useFactory: (
      db: Kysely<Database>,
      boss: ReturnType<typeof createBoss>,
      config: ApiConfig,
      audience: CheckAssetAudience,
    ): DataExportUseCases =>
      dataExportFor(db, boss, {
        gather: (scope, person) => exportCurrentPerson(scope, person, audience),
        lockTimeoutMs: config.scopeLockTimeoutMs,
      }),
  },
  {
    // Redeeming a link needs no caller: the link is the credential.
    provide: CONSUME_DATA_EXPORT_LINK,
    inject: [DATA_EXPORT],
    useFactory: (exports: DataExportUseCases): ConsumeDataExportLink => exports.consume,
  },
];
