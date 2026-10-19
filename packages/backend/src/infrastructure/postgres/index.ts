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
  ScopeBusyError,
  ScopeClosedError,
  advanceScopeRevision,
  makeWithPersonalScope,
  transactionOf,
  type PersonalScopeOptions,
} from './personal-scope.js';
export {
  NestedTransactionError,
  NetworkInTransactionError,
  assertOutsideTransaction,
  insideTransaction,
} from './transaction-marker.js';
