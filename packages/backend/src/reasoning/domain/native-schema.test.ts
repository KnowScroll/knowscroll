import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScrollDraft } from '@knowscroll/scroll-model/producer';
import { deriveNativeInputSchema, isNativeInputSchema, NATIVE_SCHEMA_LIMITS } from './native-schema.js';

describe('advisory native input schema (CI source fixtures only)', () => {
  it('derives pre-transform input without executing transformations or replacing semantic validation', () => {
    let transforms = 0;
    let refinements = 0;
    const input = z
      .strictObject({ candidateIds: z.array(z.string()).min(4).max(8) })
      .refine(() => {
        refinements += 1;
        return false;
      })
      .transform(() => {
        transforms += 1;
        return { hydrated: true };
      });
    const schema = deriveNativeInputSchema(input);
    expect(schema).toEqual({
      type: 'object',
      properties: { candidateIds: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 8 } },
      required: ['candidateIds'],
      additionalProperties: false,
    });
    expect(transforms).toBe(0);
    expect(refinements).toBe(0);
    expect(input.safeParse({ candidateIds: ['a', 'b', 'c', 'd'] }).success).toBe(false);
    expect(refinements).toBe(1);
    expect(transforms).toBe(0);
  });

  it('uses canonical ScrollDraft structure with bounded reused local definitions', () => {
    const schema = deriveNativeInputSchema(ScrollDraft);
    expect(schema).toBeDefined();
    expect(schema).toMatchObject({
      type: 'object',
      required: ['draftVersion', 'title', 'dek', 'sections', 'bindings'],
    });
    expect(schema?.['properties']).toMatchObject({ sections: { type: 'array' }, bindings: { type: 'array' } });
    expect(schema?.['definitions']).toBeDefined();
    expect(JSON.stringify(schema)).toContain('#/definitions/');
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThanOrEqual(NATIVE_SCHEMA_LIMITS.bytes);
  });

  it('drops every registry annotation instead of sending metadata, IDs, descriptions or examples', () => {
    const schema = z
      .strictObject({
        title: z
          .string()
          .meta({ type: 'number', description: 'PRIVATE-METADATA', examples: ['https://private.invalid'] }),
      })
      .meta({ id: 'https://private.invalid/schema', custom: 'PRIVATE-ROOT' });
    expect(deriveNativeInputSchema(schema)).toEqual({
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    });
  });

  it('refuses unrepresentable or unsupported input instead of widening it to any', () => {
    for (const schema of [
      z.string(),
      z.strictObject({ value: z.bigint() }),
      z.strictObject({ value: z.date() }),
      z.strictObject({ value: z.custom() }),
      z.strictObject({ url: z.url() }),
      z.strictObject({ literal: z.literal('https://private.invalid') }),
    ])
      expect(deriveNativeInputSchema(schema)).toBeUndefined();
    const Recursive: z.ZodType = z.lazy(() => z.strictObject({ nested: Recursive }));
    expect(deriveNativeInputSchema(Recursive)).toBeUndefined();
  });

  it('refuses unknown vocabulary, remote/missing/cyclic references and invalid keyword values', () => {
    const root = { type: 'object', properties: { value: { type: 'string' } } };
    for (const schema of [
      { ...root, $schema: 'https://json-schema.org/draft-07/schema#' },
      { ...root, description: 'PRIVATE' },
      { ...root, $id: 'local' },
      { ...root, properties: { value: { $ref: 'https://private.invalid/schema' } } },
      { ...root, properties: { value: { $ref: '#/definitions/missing' } } },
      {
        ...root,
        properties: { value: { $ref: '#/definitions/loop' } },
        definitions: { loop: { $ref: '#/definitions/loop' } },
      },
      { ...root, properties: { value: { type: 'date' } } },
      { ...root, properties: { value: { minItems: -1 } } },
      { ...root, properties: { value: { multipleOf: 0 } } },
      { ...root, required: ['value', 'value'] },
      { ...root, properties: { value: { anyOf: [] } } },
    ])
      expect(isNativeInputSchema(schema)).toBe(false);
  });

  it('refuses byte, node, depth, string and map overflows before provider admission', () => {
    const string = { type: 'string', enum: Array.from({ length: 200 }, (_, i) => `${i}${'x'.repeat(200)}`) };
    expect(isNativeInputSchema({ type: 'object', properties: { value: string } })).toBe(false);
    expect(
      isNativeInputSchema({
        type: 'object',
        properties: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`v${i}`, {}])),
      }),
    ).toBe(false);
    expect(isNativeInputSchema({ type: 'object', properties: { value: { pattern: 'x'.repeat(1025) } } })).toBe(false);
    let nested: unknown = { type: 'string' };
    for (let i = 0; i < 25; i++) nested = { type: 'array', items: nested };
    expect(isNativeInputSchema({ type: 'object', properties: { nested } })).toBe(false);
    const wide = {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`v${i}`, { enum: Array(20).fill(0) }])),
    };
    expect(isNativeInputSchema(wide)).toBe(false);
  });

  it('never invokes unknown schema data getters or serialization hooks', () => {
    let reads = 0;
    const schema = { type: 'object', properties: {} };
    Object.defineProperty(schema, 'private', {
      enumerable: true,
      get() {
        reads++;
        return 'PRIVATE';
      },
    });
    expect(isNativeInputSchema(schema)).toBe(false);
    expect(reads).toBe(0);
    expect(isNativeInputSchema({ type: 'object', properties: {}, toJSON: () => ({}) })).toBe(false);
  });
});
