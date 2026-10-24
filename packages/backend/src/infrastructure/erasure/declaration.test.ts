import { describe, expect, it } from 'vitest';
import { declareErasure, type ErasureDeclaration } from './declaration.js';
import { clearExplorationRegistry, exportNothing, exportReading } from './registry.js';

const erased = () => Promise.resolve({ module: 'fixture', status: 'completed' as const, removed: 0 });

/** One universe table, one account-linked column in another table and one queue store. */
const stores = {
  module: 'fixture',
  tables: [{ schema: 'fixture', table: 'rows', ownerColumn: 'universe_id' }],
  accountColumns: [{ schema: 'fixture', table: 'links', column: 'actor_account_id' }],
  nonRowStores: [{ name: 'pgboss/fixture.work', description: 'IDs only' }],
  erase: erased,
} as const;

const declare = (overrides: Partial<ErasureDeclaration> = {}) =>
  declareErasure({
    ...stores,
    clear: { defaultDisposition: 'erase', erase: erased },
    export: (declaration) => exportNothing(declaration, 'internal'),
    ...overrides,
  });

describe('declareErasure', () => {
  it('keeps the stores and erasers as written', () => {
    expect(declare()).toMatchObject({
      module: 'fixture',
      tables: stores.tables,
      accountColumns: stores.accountColumns,
      nonRowStores: stores.nonRowStores,
      erase: stores.erase,
    });
  });

  it('gives every declared store the default disposition, with the module’s exceptions', () => {
    expect(declare().clearExploration?.dispositions).toEqual({
      'fixture.rows': 'erase',
      'fixture.links': 'erase',
      'store:pgboss/fixture.work': 'erase',
    });
    const withExceptions = declare({
      clear: {
        defaultDisposition: 'erase',
        dispositions: { 'fixture.links': 'preserve', 'store:pgboss/fixture.work': 'external_retention' },
        erase: erased,
      },
    });
    expect(withExceptions.clearExploration?.dispositions).toEqual({
      'fixture.rows': 'erase',
      'fixture.links': 'preserve',
      'store:pgboss/fixture.work': 'external_retention',
    });
  });

  it('passes the owner’s Clear eraser through untouched', () => {
    const clearErase = () => Promise.resolve({ module: 'fixture', status: 'completed' as const, removed: 3 });
    const declaration = declare({ clear: { defaultDisposition: 'erase', erase: clearErase } });
    expect(declaration.clearExploration).toMatchObject({ erase: clearErase });
  });

  it('builds the export from the finished declaration, so it accounts for every declared store', () => {
    const declaration = declare({
      export: (finished) => exportReading(finished, ['fixture.rows'], 'internal', () => Promise.resolve({})),
    });
    expect(declaration.export?.covers).toEqual(['fixture.rows']);
    expect(Object.keys(declaration.export?.omits ?? {}).sort()).toEqual(['fixture.links', 'store:pgboss/fixture.work']);
  });

  describe('without a default disposition', () => {
    const registryOf = (clear: ErasureDeclaration['clear']) => () => clearExplorationRegistry([declare({ clear })], []);

    it('leaves an unnamed store without an answer, so start-up refuses it', () => {
      const partial = { dispositions: { 'fixture.rows': 'erase' }, erase: erased } as const;
      expect(declare({ clear: partial }).clearExploration?.dispositions).toEqual({ 'fixture.rows': 'erase' });
      expect(registryOf(partial)).toThrow('CLEAR_DISPOSITION_MISSING');
    });

    it('keeps a disposition for a store the module does not declare, so start-up refuses it', () => {
      const surplus = {
        defaultDisposition: 'erase',
        dispositions: { 'fixture.unknown': 'preserve' },
        erase: erased,
      } as const;
      expect(declare({ clear: surplus }).clearExploration?.dispositions).toMatchObject({
        'fixture.unknown': 'preserve',
      });
      expect(registryOf(surplus)).toThrow('CLEAR_DISPOSITION_MISSING');
    });
  });
});
