import { clearCoreTransactionOf, markClearRemovalVerified } from '../postgres/privacy-scope.js';
import type { AccountDeletionTx, ClearCoreTx, PersonalScopeTx } from '../../modules/identity/public.js';

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

/** Who an export is for. Modules read their own account-keyed rows by `accountId`, universe rows by the scope. */
export interface ExportPerson {
  readonly accountId: string;
}

/**
 * What a module puts in a person's export file (blueprint §19 "Export", D-043). The registry list
 * drives it like it drives erasure: every declared store is either read here (`covers`) or left
 * out with the reason (`omits`), so a new store cannot be forgotten.
 *
 * `read` runs inside the locked personal scope and returns plain JSON sections: bounded lists of
 * the person's own records with readable fields only. Never another person's data or identifiers,
 * internal IDs and hashes, tokens, scores, prompts or provider secrets.
 */
export interface ModuleExport {
  /** Declared stores (`schema.table` or `store:<name>`) that `read` reports on. */
  readonly covers: readonly string[];
  /** Declared stores left out on purpose, each with its reason. */
  readonly omits: Readonly<Record<string, string>>;
  read(scope: PersonalScopeTx, person: ExportPerson): Promise<Readonly<Record<string, unknown>>>;
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
  /**
   * Account deletion only: removes the account-keyed rows and account links this module owns
   * (`accountTables`, `accountColumns` outside its own `tables`) after every `erase` has run.
   * Idempotent like `erase`. Required when the module declares such stores.
   */
  eraseAccount?(scope: AccountDeletionTx): Promise<ErasureReport>;
  /** What the person's export holds of this module. Required in the real registry. */
  export?: ModuleExport;
  /** Separate capability, owner callback and per-store disposition for selective Clear. */
  clearExploration?: {
    readonly dispositions: Readonly<Record<string, 'erase' | 'preserve' | 'redact_accounting' | 'external_retention'>>;
    erase(scope: ClearCoreTx): Promise<ErasureReport>;
  };
}

/** The complete registry. Refuses a table or store declared by two modules. */
export function erasureRegistry(modules: readonly ModuleErasure[]): readonly ModuleErasure[] {
  const seen = new Set<string>();
  const owners = new Set<string>();
  for (const declaration of modules) {
    if (owners.has(declaration.module)) throw new Error('ERASURE_OWNER_DUPLICATED');
    owners.add(declaration.module);
    const names = new Set<string>();
    for (const group of [
      declaration.tables.map((t) => `${t.schema}.${t.table}`),
      (declaration.accountTables ?? []).map((t) => `${t.schema}.${t.table}`),
      declaration.nonRowStores.map((s) => `store:${s.name}`),
    ]) {
      if (new Set(group).size !== group.length) throw new Error('ERASURE_STORE_DUPLICATED');
      for (const name of group) names.add(name);
    }
    for (const name of names) {
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
const clearVerifiers = new WeakMap<readonly ModuleErasure[], (scope: ClearCoreTx) => Promise<boolean>>();
export function clearExplorationRegistry(
  registry: readonly ModuleErasure[],
  inventory?: readonly ModuleErasure[],
  verify?: (scope: ClearCoreTx) => Promise<boolean>,
): readonly ModuleErasure[] {
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
  if (
    !inventory ||
    !verify ||
    registry.length !== inventory.length ||
    inventory.some((owner) => !registry.some((d) => d.module === owner.module))
  )
    throw new Error('CLEAR_INVENTORY_UNVERIFIED');
  const complete = Object.freeze([...registry]);
  clearVerifiers.set(complete, verify);
  return complete;
}
export async function eraseExploration(
  scope: ClearCoreTx,
  registry: readonly ModuleErasure[],
): Promise<readonly ErasureReport[]> {
  clearCoreTransactionOf(scope);
  const verify = clearVerifiers.get(registry);
  if (!verify || !(await verify(scope))) throw new Error('CLEAR_INVENTORY_UNVERIFIED');
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

/** `schema.table` for every row store a module declares, and `store:<name>` for the others. */
function declaredStores(declaration: ModuleErasure): readonly string[] {
  const names = new Set([
    ...declaration.tables.map((t) => `${t.schema}.${t.table}`),
    ...(declaration.accountTables ?? []).map((t) => `${t.schema}.${t.table}`),
    ...(declaration.accountColumns ?? []).map((t) => `${t.schema}.${t.table}`),
    ...declaration.nonRowStores.map((s) => `store:${s.name}`),
  ]);
  return [...names];
}

/**
 * An export that reads `covers` with `read` and leaves every other declared store out for one
 * reason (internal bookkeeping, derived scores, shared with another person). Use it when one
 * reason fits; a module whose omissions differ writes its `omits` out.
 */
export function exportReading(
  declaration: ModuleErasure,
  covers: readonly string[],
  omitReason: string,
  read: ModuleExport['read'],
): ModuleExport {
  const omitted = declaredStores(declaration).filter((name) => !covers.includes(name));
  return { covers, omits: Object.fromEntries(omitted.map((name) => [name, omitReason])), read };
}

/** An export of a module whose stores are all internal: nothing is read. */
export function exportNothing(declaration: ModuleErasure, reason: string): ModuleExport {
  return exportReading(declaration, [], reason, () => Promise.resolve({}));
}

/**
 * The registry for account deletion and export. Refuses, at start-up, a module that holds
 * account-keyed stores without an `eraseAccount`, one without an `export`, and an export that does
 * not account for exactly the stores the module declares.
 */
export function accountLifecycleRegistry(modules: readonly ModuleErasure[]): readonly ModuleErasure[] {
  for (const declaration of modules) {
    const ownTables = new Set(declaration.tables.map((t) => `${t.schema}.${t.table}`));
    const holdsAccountStores =
      (declaration.accountTables ?? []).length > 0 ||
      (declaration.accountColumns ?? []).some((c) => !ownTables.has(`${c.schema}.${c.table}`));
    if (holdsAccountStores && declaration.eraseAccount === undefined)
      throw new Error(`ACCOUNT_ERASER_MISSING: ${declaration.module}`);
    const exported = declaration.export;
    if (exported === undefined) throw new Error(`EXPORT_OWNER_MISSING: ${declaration.module}`);
    const accounted = [...exported.covers, ...Object.keys(exported.omits)];
    const declared = declaredStores(declaration);
    if (
      new Set(accounted).size !== accounted.length ||
      declared.some((name) => !accounted.includes(name)) ||
      accounted.some((name) => !declared.includes(name))
    )
      throw new Error(`EXPORT_COVERAGE_MISMATCH: ${declaration.module}`);
  }
  return modules;
}

/**
 * Account deletion's erasers over the deleting universe: every module's `erase` first (universe
 * rows, queue payloads), then every `eraseAccount` (account-keyed rows and links). Returns each
 * report; the caller decides what `pending` means. A thrown error rolls the transaction back.
 */
export async function eraseAccountData(
  scope: AccountDeletionTx,
  registry: readonly ModuleErasure[],
): Promise<readonly ErasureReport[]> {
  const reports: ErasureReport[] = [];
  for (const declaration of registry) reports.push(await declaration.erase(scope.personal));
  for (const declaration of registry) {
    if (declaration.eraseAccount !== undefined) reports.push(await declaration.eraseAccount(scope));
  }
  return reports;
}

/** The most records one export section lists; a section that had more says `truncated`. */
export const EXPORT_LIST_LIMIT = 2000;

/**
 * A list section for the export file. Query `EXPORT_LIST_LIMIT + 1` rows, newest first: the extra
 * row only tells us the list was cut, and is not returned.
 */
export function boundedSection<T>(rows: readonly T[]): { readonly items: readonly T[]; readonly truncated: boolean } {
  return { items: rows.slice(0, EXPORT_LIST_LIMIT), truncated: rows.length > EXPORT_LIST_LIMIT };
}

/** The export file's structure version. A change to a section's shape bumps it. */
export const EXPORT_VERSION = 'knowscroll-export.v1';

/** Every module's export section for one person, keyed by module name. Empty sections are kept. */
export async function exportPersonalData(
  scope: PersonalScopeTx,
  registry: readonly ModuleErasure[],
  person: ExportPerson,
): Promise<{ readonly version: typeof EXPORT_VERSION; readonly sections: Record<string, unknown> }> {
  const sections: Record<string, unknown> = {};
  for (const declaration of registry) {
    if (declaration.export === undefined) throw new Error(`EXPORT_OWNER_MISSING: ${declaration.module}`);
    sections[declaration.module] = await declaration.export.read(scope, person);
  }
  return { version: EXPORT_VERSION, sections };
}
