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

/** Loads every registered migration's SQL text in registry order. Synchronous file reads at startup. */
export function loadMigrations(): readonly LoadedMigration[] {
  return migrationRegistry.map((entry) => ({
    ...entry,
    sql: readFileSync(new URL(`${entry.name}.sql`, migrationDirectory), 'utf8'),
  }));
}
