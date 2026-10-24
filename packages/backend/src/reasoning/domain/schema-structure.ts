import type { z } from 'zod';

/**
 * How one schema is built, as far as the issue-path masking needs to know. `inner`, `element` and
 * the other members are schemas again; this module never looks inside them.
 *
 * - `wrapper`: the schema checks the same value as `inner` (optional, nullable, default, readonly,
 *   a pipe's input side, a lazy schema's resolved schema).
 * - `keyed`: a record or map: any key reaches `value`.
 */
export type SchemaStructure =
  | { readonly kind: 'wrapper'; readonly inner: unknown }
  | { readonly kind: 'object'; readonly shape: Readonly<Record<string, unknown>> }
  | { readonly kind: 'array'; readonly element: unknown }
  | { readonly kind: 'tuple'; readonly items: readonly unknown[]; readonly rest: unknown }
  | { readonly kind: 'keyed'; readonly value: unknown }
  | { readonly kind: 'union'; readonly options: readonly unknown[] }
  | { readonly kind: 'intersection'; readonly left: unknown; readonly right: unknown };

/**
 * The definitions this module understands, as Zod exports them. Naming Zod's own definition types
 * means a renamed field fails the type check, and a renamed `type` literal is refused by the
 * `switch` below, instead of silently masking every path.
 */
type KnownDefinition =
  | z.core.$ZodOptionalDef
  | z.core.$ZodNullableDef
  | z.core.$ZodDefaultDef
  | z.core.$ZodPrefaultDef
  | z.core.$ZodReadonlyDef
  | z.core.$ZodCatchDef
  | z.core.$ZodNonOptionalDef
  | z.core.$ZodPipeDef
  | z.core.$ZodLazyDef
  | z.core.$ZodObjectDef
  | z.core.$ZodArrayDef
  | z.core.$ZodTupleDef
  | z.core.$ZodRecordDef
  | z.core.$ZodMapDef
  | z.core.$ZodUnionDef
  | z.core.$ZodIntersectionDef;

/**
 * A schema's public `def` (Zod classic's documented accessor; `_def` and `_zod` are not used).
 * Anything that does not carry one, or carries a type this module does not know, has no structure.
 */
function definitionOf(schema: unknown): KnownDefinition | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const definition: unknown = (schema as { readonly def?: unknown }).def;
  if (typeof definition !== 'object' || definition === null) return undefined;
  return typeof (definition as { readonly type?: unknown }).type === 'string'
    ? (definition as KnownDefinition)
    : undefined;
}

/**
 * The structure of `schema`, or `undefined` for a leaf (a string, a number, a literal), for an
 * unknown kind of schema and for a value that is no schema at all. Pure, except that a lazy schema
 * runs its own getter, which may throw: the caller treats a throw as an unreadable schema.
 */
export function structureOf(schema: unknown): SchemaStructure | undefined {
  const definition = definitionOf(schema);
  if (definition === undefined) return undefined;
  switch (definition.type) {
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return { kind: 'wrapper', inner: definition.innerType };
    case 'pipe':
      return { kind: 'wrapper', inner: definition.in };
    case 'lazy':
      return { kind: 'wrapper', inner: definition.getter() };
    case 'object':
      return { kind: 'object', shape: definition.shape };
    case 'array':
      return { kind: 'array', element: definition.element };
    case 'tuple':
      return { kind: 'tuple', items: definition.items, rest: definition.rest };
    case 'record':
    case 'map':
      return { kind: 'keyed', value: definition.valueType };
    case 'union':
      return { kind: 'union', options: definition.options };
    case 'intersection':
      return { kind: 'intersection', left: definition.left, right: definition.right };
  }
  return undefined;
}
