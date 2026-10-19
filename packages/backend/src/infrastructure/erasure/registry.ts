import type { PersonalScopeTx } from '../../modules/identity/public.js';

/** A personal SQL table and the column that names its universe. */
export interface PersonalTable {
  readonly schema: string;
  readonly table: string;
  readonly ownerColumn: 'universe_id';
}

/**
 * A personal store that SQL introspection cannot find (job payloads, media, caches, model
 * artifacts, diagnostic exports). Each is declared by name with the eraser that clears it.
 */
export interface PersonalNonRowStore {
  readonly name: string;
  readonly description: string;
}

/** What an eraser achieved for one module. `pending` means more work remains and a retry is safe. */
export interface ErasureReport {
  readonly module: string;
  readonly status: 'completed' | 'pending' | 'failed';
  readonly removed: number;
}

/**
 * One module's erasure declaration (blueprint §5 "Erasure registry"): every personal table and
 * non-row store it owns, and the eraser that removes one universe's data from them inside the
 * locked personal scope. Erasers are idempotent (safe retry) and never restore an older epoch.
 */
export interface ModuleErasure {
  readonly module: string;
  readonly tables: readonly PersonalTable[];
  readonly nonRowStores: readonly PersonalNonRowStore[];
  /** Erasers run in registry order; list dependants (rows referencing others) first. */
  erase(scope: PersonalScopeTx): Promise<ErasureReport>;
}

/** The complete registry. Refuses a table or store declared by two modules. */
export function erasureRegistry(modules: readonly ModuleErasure[]): readonly ModuleErasure[] {
  const seen = new Set<string>();
  for (const declaration of modules) {
    for (const name of [
      ...declaration.tables.map((table) => `${table.schema}.${table.table}`),
      ...declaration.nonRowStores.map((store) => `store:${store.name}`),
    ]) {
      if (seen.has(name)) throw new Error(`${name} is declared by two modules`);
      seen.add(name);
    }
  }
  return modules;
}

/** Runs every module's eraser for the scope's universe, in registry order. */
export async function eraseUniverse(
  scope: PersonalScopeTx,
  registry: readonly ModuleErasure[],
): Promise<readonly ErasureReport[]> {
  const reports: ErasureReport[] = [];
  for (const declaration of registry) reports.push(await declaration.erase(scope));
  return reports;
}
