/**
 * Completeness of `textFields`, the one enumeration of reader-facing text that feeds the visible
 * text limit, the numeric honesty check, the copy check (D-013) and the binding addresses.
 *
 * A free-text property that the enumeration forgot would escape all four checks at once. So this
 * test reads the block schema itself: it builds, for every block type and every branch of every
 * union, an instance with every property present and a unique marker in every free-text string,
 * then requires `textFields` to return each marker. New text added to a schema without being
 * listed in `textFields` fails here, naming the path.
 */
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Block, isTextBlockType, textFields, type AnyBlock } from './index.js';
import { fixture } from './test-support/fixtures.js';

interface JsonSchema {
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly type?: string;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly prefixItems?: readonly JsonSchema[];
}

const MARKER = /^zq\d+zq$/u;

/**
 * Every instance of a schema: one per branch of each union, with all properties present. Within an
 * object, each property's alternatives are varied one at a time against the first alternatives of
 * the others, so every branch appears in some instance without a combinatorial blow-up.
 */
function instances(schema: JsonSchema, counter: { n: number }): unknown[] {
  const branches = schema.oneOf ?? schema.anyOf;
  if (branches !== undefined) return branches.flatMap((branch) => instances(branch, counter));
  if (schema.const !== undefined) return [schema.const];
  if (schema.enum !== undefined) return [schema.enum[0]];
  if (schema.type === 'string') {
    // Ids, keys and digests carry a pattern; free text does not.
    counter.n += 1;
    return [schema.pattern === undefined ? `zq${counter.n}zq` : 'abc-d'];
  }
  if (schema.type === 'number' || schema.type === 'integer') return [Math.max(schema.minimum ?? 1, 1)];
  if (schema.type === 'boolean') return [true];
  if (schema.type === 'array') {
    if (schema.prefixItems !== undefined) return [schema.prefixItems.map((item) => instances(item, counter)[0])];
    return [schema.items === undefined ? [] : instances(schema.items, counter)];
  }
  if (schema.type === 'object') {
    const properties = Object.entries(schema.properties ?? {}).map(
      ([key, property]) => [key, instances(property, counter)] as const,
    );
    const base = Object.fromEntries(properties.map(([key, options]) => [key, options[0]]));
    const out: unknown[] = [base];
    for (const [key, options] of properties)
      for (const option of options.slice(1)) out.push({ ...base, [key]: option });
    return out;
  }
  return [null];
}

/** Markers in an instance with their paths. */
function markersIn(value: unknown, path: string, found: Array<{ path: string; marker: string }>): void {
  if (typeof value === 'string') {
    if (MARKER.test(value)) found.push({ path, marker: value });
  } else if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => markersIn(item, `${path}.${index}`, found));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) markersIn(item, path === '' ? key : `${path}.${key}`, found);
  }
}

describe('textFields lists every free-text property of every block type', () => {
  const schema = z.toJSONSchema(Block, { target: 'draft-2020-12', unrepresentable: 'any' }) as JsonSchema;
  const blocks = instances(schema, { n: 0 }) as AnyBlock[];

  it('builds an instance for every block type and union branch', () => {
    const types = new Set(blocks.map((block) => block.type));
    expect(types.size).toBe(17);
    expect(blocks.length).toBeGreaterThan(20);
  });

  it('returns a marker planted in any free-text property, except text the enumeration derives or leaves to children', () => {
    const missing: string[] = [];
    let planted = 0;
    for (const block of blocks) {
      const texts = textFields(block).map((field) => field.text);
      const found: Array<{ path: string; marker: string }> = [];
      markersIn(block, '', found);
      for (const { path, marker } of found) {
        // A text block's (and a fallback's) accessibility text is derived or copied; a disclosure's
        // children are blocks of their own and are enumerated when they are visited.
        if (path.startsWith('a11y.') && (isTextBlockType(block.type) || block.type === 'fallback')) continue;
        if (block.type === 'disclosure' && path.startsWith('data.blocks.')) continue;
        planted += 1;
        if (!texts.some((text) => text.includes(marker))) missing.push(`${block.type}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
    expect(planted).toBeGreaterThan(150);
  });
});

describe('the illustrative notice is reader-facing text', () => {
  it('is listed as visible text for an illustrative simulation and absent for any other', () => {
    const attention = fixture('attention-slowly').document.sections[1]?.blocks[2];
    const weight = fixture('weight-other-worlds').document.sections[0]?.blocks[0];
    if (attention?.type !== 'simulation' || weight?.type !== 'simulation') throw new Error('fixture changed');
    expect(textFields(attention)).toContainEqual({
      field: 'data.illustrative.notice',
      text: 'Illustrative',
      visible: true,
      code: false,
      unit: false,
    });
    expect(textFields(weight).some((field) => field.field === 'data.illustrative.notice')).toBe(false);
  });
});
