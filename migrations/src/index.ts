import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { migrationRegistry } from './registry.js';

export { migrationRegistry } from './registry.js';

/** One registry entry with its SQL text loaded from `<name>.sql` in this folder. */
export interface LoadedMigration {
  readonly name: string;
  readonly sha256: string;
  readonly sql: string;
}

/** The package folder holding the reviewed `.sql` files, resolved from this module (src/ or dist/). */
export const migrationDirectory = new URL('../', import.meta.url);

/**
 * Loads every registered migration's SQL text in registry order (synchronous reads at startup)
 * and refuses to return a file whose text does not match its recorded SHA-256, so a release can
 * never apply text other than what was reviewed. The migrator checks the hashes again, against
 * the hashes recorded in the database for migrations already applied.
 */
export function loadMigrations(): readonly LoadedMigration[] {
  return migrationRegistry.map((entry) => {
    const text = readFileSync(new URL(`${entry.name}.sql`, migrationDirectory), 'utf8');
    const actual = createHash('sha256').update(text).digest('hex');
    if (actual !== entry.sha256) throw new Error(`Migration ${entry.name} does not match its recorded SHA-256`);
    return { ...entry, sql: text };
  });
}
