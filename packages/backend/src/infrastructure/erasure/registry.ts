import { checkErasureInventory } from './inventory.js';
import { clearCoreTransactionOf, markClearRemovalVerified } from '../postgres/privacy-scope.js';
import type { ClearCoreTx, PersonalScopeTx } from '../../modules/identity/public.js';

/** A personal SQL table and the column that names its universe. */
export interface PersonalTable {
  readonly schema: string;
  readonly table: string;
  readonly ownerColumn: 'universe_id';
}

/**
 * A column that links rows to an account (outside the identity schema). Account deletion has to
 * handle these explicitly (they reference the account with `ON DELETE RESTRICT`), so each is
 * declared by the module that owns it.
 */
export interface AccountColumn {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

/**
 * A table of personal records keyed by account rather than universe (identity's addresses,
 * sign-in links and sessions). Clearing or resetting a universe leaves them alone; account
 * deletion (the privacy work's own lifecycle) removes them. `ownerColumn` names how a row finds
 * its person: the account column, or the address for a link that may precede any account.
 */
export interface AccountTable {
  readonly schema: string;
  readonly table: string;
  readonly ownerColumn: string;
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
  /** Account-linked columns this module owns (handled by the account-deletion lifecycle). */
  readonly accountColumns?: readonly AccountColumn[];
  /** Account-keyed personal tables this module owns (erased by account deletion, not by `erase`). */
  readonly accountTables?: readonly AccountTable[];
  /** Erasers run in registry order; list dependants (rows referencing others) first. */
  erase(scope: PersonalScopeTx): Promise<ErasureReport>;
  /** Separate capability, owner callback and per-store disposition for selective Clear. */
  clearExploration?: {
    readonly dispositions: Readonly<Record<string, 'erase' | 'preserve' | 'redact_accounting' | 'external_retention'>>;
    erase(scope: ClearCoreTx): Promise<ErasureReport>;
  };
}

/** The complete registry. Refuses a table or store declared by two modules. */
export function erasureRegistry(modules: readonly ModuleErasure[]): readonly ModuleErasure[] {
  const seen = new Set<string>();
  for (const declaration of modules) {
    for (const name of [
      ...declaration.tables.map((table) => `${table.schema}.${table.table}`),
      ...(declaration.accountTables ?? []).map((table) => `${table.schema}.${table.table}`),
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

/** Every declared store needs an explicit disposition; omission refuses cleanup before any SQL. */
export function clearExplorationRegistry(registry: readonly ModuleErasure[]): readonly ModuleErasure[] {
  for (const d of registry) {
    const clear = d.clearExploration;
    if (!clear) throw new Error('CLEAR_OWNER_MISSING');
    const names = [
      ...d.tables.map((t) => `${t.schema}.${t.table}`),
      ...(d.accountTables ?? []).map((t) => `${t.schema}.${t.table}`),
      ...(d.accountColumns ?? []).map((t) => `${t.schema}.${t.table}`),
      ...d.nonRowStores.map((s) => `store:${s.name}`),
    ];
    if (
      names.some((n) => !Object.hasOwn(clear.dispositions, n)) ||
      Object.keys(clear.dispositions).some((n) => !names.includes(n))
    )
      throw new Error('CLEAR_DISPOSITION_MISSING');
  }
  return registry;
}
export async function eraseExploration(
  scope: ClearCoreTx,
  registry: readonly ModuleErasure[],
): Promise<readonly ErasureReport[]> {
  const trx = clearCoreTransactionOf(scope);
  clearExplorationRegistry(registry);
  if ((await checkErasureInventory(trx, registry)).length > 0) throw new Error('CLEAR_INVENTORY_UNVERIFIED');
  const reports: ErasureReport[] = [];
  for (const d of registry) {
    clearCoreTransactionOf(scope);
    const report = await d.clearExploration!.erase(scope);
    if (report.module !== d.module || report.status !== 'completed') throw new Error('CLEAR_OWNER_UNVERIFIED');
    reports.push(report);
  }
  markClearRemovalVerified(scope);
  return reports;
}
