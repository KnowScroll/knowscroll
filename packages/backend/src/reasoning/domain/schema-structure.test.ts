import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { structureOf } from './schema-structure.js';

/**
 * The issue-path masking reads schemas only through `structureOf`. These tests pin it against the
 * Zod version in use, so an upgrade that changes how a schema describes itself fails here rather
 * than masking every path in production.
 */
describe('structureOf', () => {
  const title = z.string();
  const count = z.number();

  it('exposes an object’s declared fields', () => {
    const schema = z.object({ title, count });
    expect(structureOf(schema)).toEqual({ kind: 'object', shape: { title, count } });
  });

  it('exposes an array’s element and a tuple’s items and rest', () => {
    expect(structureOf(z.array(title))).toEqual({ kind: 'array', element: title });
    expect(structureOf(z.tuple([title, count]))).toEqual({ kind: 'tuple', items: [title, count], rest: null });
    expect(structureOf(z.tuple([title]).rest(count))).toEqual({ kind: 'tuple', items: [title], rest: count });
  });

  it('treats a record and a map alike: any key reaches the value', () => {
    expect(structureOf(z.record(z.string(), count))).toEqual({ kind: 'keyed', value: count });
    expect(structureOf(z.map(z.string(), count))).toEqual({ kind: 'keyed', value: count });
  });

  it('lists the branches of a union, a discriminated union and an intersection', () => {
    const left = z.object({ kind: z.literal('a') });
    const right = z.object({ kind: z.literal('b') });
    expect(structureOf(z.union([left, right]))).toEqual({ kind: 'union', options: [left, right] });
    expect(structureOf(z.discriminatedUnion('kind', [left, right]))).toEqual({ kind: 'union', options: [left, right] });
    expect(structureOf(z.intersection(left, right))).toEqual({ kind: 'intersection', left, right });
  });

  it.each([
    ['optional', title.optional()],
    ['nullable', title.nullable()],
    ['default', title.default('x')],
    ['prefault', title.prefault('x')],
    ['readonly', title.readonly()],
    ['catch', title.catch('x')],
    ['nonoptional', title.optional().pipe(z.string()).nonoptional()],
  ] as const)('sees through %s to the schema it wraps', (_name, schema) => {
    const structure = structureOf(schema);
    expect(structure?.kind).toBe('wrapper');
  });

  it('sees through a wrapper to the inner schema itself', () => {
    expect(structureOf(title.optional())).toEqual({ kind: 'wrapper', inner: title });
    expect(structureOf(title.nullable())).toEqual({ kind: 'wrapper', inner: title });
  });

  it('follows a pipe or transform through its input side', () => {
    const piped = title.transform((text) => text.length);
    expect(structureOf(piped)).toEqual({ kind: 'wrapper', inner: title });
    expect(structureOf(z.pipe(title, count))).toEqual({ kind: 'wrapper', inner: title });
  });

  it('resolves a lazy schema by running its getter', () => {
    const target = z.object({ title });
    expect(structureOf(z.lazy(() => target))).toEqual({ kind: 'wrapper', inner: target });
  });

  it('lets a lazy schema’s own failure through, for the caller to treat as unreadable', () => {
    const broken = z.lazy(() => {
      throw new Error('no schema');
    });
    expect(() => structureOf(broken)).toThrow('no schema');
  });

  it.each([
    ['a string', z.string()],
    ['a number', z.number()],
    ['a literal', z.literal('a')],
    ['an enum', z.enum(['a', 'b'])],
    ['anything', z.any()],
  ] as const)('has no structure for %s', (_name, schema) => {
    expect(structureOf(schema)).toBeUndefined();
  });

  it.each([undefined, null, 'title', 3, {}, { def: null }, { def: {} }, { def: { type: 7 } }])(
    'has no structure for a value that is not a schema (%j)',
    (value) => {
      expect(structureOf(value)).toBeUndefined();
    },
  );
});
