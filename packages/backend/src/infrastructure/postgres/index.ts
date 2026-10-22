export { createDatabase, type CreateDatabaseOptions, type Database, type DatabaseHandle } from './database.js';
export {
  MigrationChecksumError,
  MIGRATION_SCHEMA,
  MIGRATION_TABLE,
  migrateToLatest,
  readLatestMigration,
  type MigrationOutcome,
  type RegisteredMigration,
} from './migrator.js';
export {
  LockOrderError,
  ScopeBusyError,
  ScopeClosedError,
  advanceScopeRevision,
  claimAccountFence,
  enterSharedRoot,
  makeAuthorityHolds,
  makeWithPersonalScope,
  makeWithResolvedPersonalScope,
  resolutionTransactionOf,
  sharedTransactionOf,
  transactionOf,
  withTransaction,
  type SharedRootLock,
  type PersonalScopeOptions,
} from './personal-scope.js';
export {
  NestedTransactionError,
  NetworkInTransactionError,
  assertOutsideTransaction,
  insideTransaction,
} from './transaction-marker.js';

export { makeWithProductionScope, makeProductionAuthorityHolds, productionTransactionOf } from './production-scope.js';

export {
  makeWithPrivacyScope,
  makeWithClearMaintenance,
  privacyTransactionOf,
  clearCoreTransactionOf,
  clearAccountingTransactionOf,
  isClearCore,
  closeClearCore,
} from './privacy-scope.js';
export { makeWithCutroomReceiveScope, cutroomReceiveTransactionOf } from './cutroom-receive-scope.js';
