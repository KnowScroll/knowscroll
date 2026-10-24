import { describe, expect, it } from 'vitest';
import { personalStores } from '../../erasure-registry.js';
import { accountLifecycleRegistry, exportNothing, exportReading, type ModuleErasure } from './registry.js';

const erased = () => Promise.resolve({ module: 'fixture', status: 'completed' as const, removed: 0 });

/** A module with one universe table, one account table and one queue store. */
const base: ModuleErasure = {
  module: 'fixture',
  tables: [{ schema: 'fixture', table: 'rows', ownerColumn: 'universe_id' }],
  accountTables: [{ schema: 'fixture', table: 'accounts', ownerColumn: 'account_id' }],
  nonRowStores: [{ name: 'pgboss/fixture.work', description: 'IDs only' }],
  erase: erased,
  eraseAccount: erased,
};
const withExport = (declaration: ModuleErasure): ModuleErasure => ({
  ...declaration,
  export: exportReading(declaration, ['fixture.rows'], 'internal', () => Promise.resolve({ rows: [] })),
});

describe('the account lifecycle registry', () => {
  it('accepts a module whose export accounts for every declared store exactly once', () => {
    const [fixture] = accountLifecycleRegistry([withExport(base)]);
    expect(fixture?.export?.covers).toEqual(['fixture.rows']);
    expect(Object.keys(fixture?.export?.omits ?? {}).sort()).toEqual(['fixture.accounts', 'store:pgboss/fixture.work']);
  });

  it('refuses a module with account-keyed stores and no account eraser', () => {
    const without: ModuleErasure = {
      module: 'fixture',
      tables: base.tables,
      accountTables: base.accountTables,
      nonRowStores: base.nonRowStores,
      erase: erased,
    };
    expect(() => accountLifecycleRegistry([withExport(without)])).toThrow('ACCOUNT_ERASER_MISSING: fixture');
  });

  it('refuses account links outside the module’s own tables without an account eraser', () => {
    const linked: ModuleErasure = {
      module: 'linked',
      tables: [],
      accountColumns: [{ schema: 'elsewhere', table: 'shared', column: 'actor_account_id' }],
      nonRowStores: [],
      erase: erased,
    };
    expect(() => accountLifecycleRegistry([{ ...linked, export: exportNothing(linked, 'internal') }])).toThrow(
      'ACCOUNT_ERASER_MISSING: linked',
    );
    // A link inside the module's own universe table is already erased by `erase`.
    const own: ModuleErasure = {
      module: 'own',
      tables: [{ schema: 'own', table: 'runs', ownerColumn: 'universe_id' }],
      accountColumns: [{ schema: 'own', table: 'runs', column: 'recording_account_id' }],
      nonRowStores: [],
      erase: erased,
    };
    expect(() => accountLifecycleRegistry([{ ...own, export: exportNothing(own, 'internal') }])).not.toThrow();
  });

  it('refuses a module with no export', () => {
    expect(() => accountLifecycleRegistry([base])).toThrow('EXPORT_OWNER_MISSING: fixture');
  });

  it('refuses an export that forgets a declared store, or names one that is not declared', () => {
    const forgetting: ModuleErasure = {
      ...base,
      export: { covers: ['fixture.rows'], omits: { 'fixture.accounts': 'internal' }, read: () => Promise.resolve({}) },
    };
    expect(() => accountLifecycleRegistry([forgetting])).toThrow('EXPORT_COVERAGE_MISMATCH: fixture');
    const inventing: ModuleErasure = {
      ...base,
      export: exportReading(base, ['fixture.rows', 'fixture.invented'], 'internal', () => Promise.resolve({})),
    };
    expect(() => accountLifecycleRegistry([inventing])).toThrow('EXPORT_COVERAGE_MISMATCH: fixture');
    const twice: ModuleErasure = {
      ...base,
      export: {
        covers: ['fixture.rows'],
        omits: { 'fixture.rows': 'again', 'fixture.accounts': 'internal', 'store:pgboss/fixture.work': 'internal' },
        read: () => Promise.resolve({}),
      },
    };
    expect(() => accountLifecycleRegistry([twice])).toThrow('EXPORT_COVERAGE_MISMATCH: fixture');
  });

  it('holds for the real registry: every module can erase its account stores and says what it exports', () => {
    expect(() => accountLifecycleRegistry(personalStores)).not.toThrow();
    for (const declaration of personalStores) expect(declaration.export, declaration.module).toBeDefined();
  });
});
