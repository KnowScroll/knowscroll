import type { Kysely } from 'kysely';
import type { PgBoss } from 'pg-boss';
import { makeEnqueueInTransaction, makeEnqueueJob } from '../../../infrastructure/jobs/index.js';
import type { Database } from '../../../infrastructure/postgres/database.js';
import { makeWithPersonalScope } from '../../../infrastructure/postgres/personal-scope.js';
import { makeDataExport } from '../application/data-export.js';
import { makeDeleteAccount, type DeleteAccountPorts } from '../application/delete-account.js';
import { fenceOwnAccount } from './account-access.js';
import { deletionStore, makeWithAccountDeletion } from './deletion-store.js';
import { exportStore } from './export-store.js';
import { cryptoSecrets } from './secrets.js';
import type { PersonalScopeTx } from '../public.js';

/**
 * Account deletion over one database (framework-free). The registry's erasers are injected by the
 * composition root (`eraseCurrentAccount`), because only it may import every module. The API uses
 * `request`, `readReceipt` and `retry`; the worker uses `process`, `fail` and `recover`.
 */
export function deleteAccountFor(
  db: Kysely<Database>,
  boss: PgBoss,
  options: { readonly eraseAccountData: DeleteAccountPorts['eraseAccountData']; readonly lockTimeoutMs: number },
) {
  const lock = { lockTimeoutMs: options.lockTimeoutMs };
  return makeDeleteAccount({
    withScope: makeWithPersonalScope(db, lock),
    fenceOwn: fenceOwnAccount,
    withDeletion: makeWithAccountDeletion(db, lock),
    eraseAccountData: options.eraseAccountData,
    ...deletionStore({ db, enqueueJob: makeEnqueueJob(boss), enqueueInTransaction: makeEnqueueInTransaction(boss) }),
  });
}

/**
 * Personal data export over one database (framework-free). `gather` is the registry's
 * `exportCurrentPerson`, injected by the composition root. The API requests, lists and hands out
 * links and redeems them; the worker builds.
 */
export function dataExportFor(
  db: Kysely<Database>,
  boss: PgBoss,
  options: {
    readonly gather: (scope: PersonalScopeTx, person: { readonly accountId: string }) => Promise<unknown>;
    readonly lockTimeoutMs: number;
  },
) {
  return makeDataExport({
    withScope: makeWithPersonalScope(db, { lockTimeoutMs: options.lockTimeoutMs }),
    secrets: cryptoSecrets,
    gather: options.gather,
    ...exportStore({ db, enqueueJob: makeEnqueueJob(boss) }),
  });
}
