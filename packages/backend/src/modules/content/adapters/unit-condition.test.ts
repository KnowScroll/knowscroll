import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { renderUnitCondition } from './unit-condition.js';

/** A Kysely that only compiles: no database is reached. */
const compiler = new Kysely<unknown>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new PostgresIntrospector(db),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});
const compile = (condition: Parameters<typeof renderUnitCondition>[0]) =>
  sql`select 1 where ${renderUnitCondition(condition, sql.ref('r.explanation_unit_id'))}`.compile(compiler);

describe('a unit condition another module supplies', () => {
  it('puts the unit column where {unit} is and binds every value as a parameter', () => {
    const query = compile({
      text: 'not exists (select 1 from experience.encounter_lineage l where l.universe_id = {0}::uuid and l.privacy_epoch = {1} and l.explanation_unit_id = {unit})',
      values: ['6f9a0b1c-0000-4000-8000-000000000000', 3],
    });
    expect(query.sql).toContain('l.explanation_unit_id = "r"."explanation_unit_id"');
    expect(query.sql).toContain('l.universe_id = $1::uuid');
    expect(query.sql).toContain('l.privacy_epoch = $2');
    expect(query.parameters).toEqual(['6f9a0b1c-0000-4000-8000-000000000000', 3]);
  });

  it('binds a value once for each place it is used', () => {
    const query = compile({ text: '{0} = {unit} or {0} = {unit}', values: ['x'] });
    expect(query.parameters).toEqual(['x', 'x']);
  });

  it.each([
    ['a quote', "{unit} = 'x'"],
    ['a semicolon', '{unit} is null; drop table content.assets'],
    ['a comment', '{unit} is null -- hi'],
    ['a block comment', '{unit} is null /* hi */'],
    ['a dollar quote', '$$ {unit} $$'],
    ['empty text', ''],
  ])('refuses %s', (_name, text) => {
    expect(() => compile({ text, values: [] })).toThrow('UNIT_CONDITION_INVALID');
  });

  it('refuses a slot with no value, and too many values', () => {
    expect(() => compile({ text: '{unit} = {1}', values: ['only-one'] })).toThrow('UNIT_CONDITION_INVALID');
    expect(() => compile({ text: '{unit} = {0}', values: Array.from({ length: 11 }, () => 'v') })).toThrow(
      'UNIT_CONDITION_INVALID',
    );
  });

  it('refuses a text longer than it needs to be', () => {
    expect(() => compile({ text: `${'a '.repeat(1100)}{unit}`, values: [] })).toThrow('UNIT_CONDITION_INVALID');
  });
});
