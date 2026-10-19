export { createDatabase, type CreateDatabaseOptions, type DatabaseHandle } from './database.js';
export {
  MigrationChecksumError,
  MIGRATION_SCHEMA,
  MIGRATION_TABLE,
  migrateToLatest,
  readLatestMigration,
  type MigrationOutcome,
  type RegisteredMigration,
} from './migrator.js';
