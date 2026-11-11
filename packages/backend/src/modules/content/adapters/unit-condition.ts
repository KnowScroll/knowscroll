import { sql, type RawBuilder } from 'kysely';
import type { UnitCondition } from '../public.js';

const ALLOWED = /^[A-Za-z0-9_.(),:<>=\s{}]*$/;
const TOKEN = /(\{unit\}|\{\d\})/;

/**
 * Renders a caller's {@link UnitCondition} over one of Content's unit columns. The caller's text is fixed code, but it still
 * crosses a module boundary, so it is checked: a short text of the allowed characters only, and every `{n}` must name a value,
 * which is bound as a parameter. Anything else is refused (`UNIT_CONDITION_INVALID`).
 */
export function renderUnitCondition(condition: UnitCondition, unit: RawBuilder<unknown>): RawBuilder<boolean> {
  if (condition.text.length === 0 || condition.text.length > 2000 || !ALLOWED.test(condition.text))
    throw new Error('UNIT_CONDITION_INVALID');
  if (condition.values.length > 10) throw new Error('UNIT_CONDITION_INVALID');
  const parts = condition.text.split(TOKEN).map((part) => {
    if (part === '{unit}') return unit;
    const slot = /^\{(\d)\}$/.exec(part);
    if (slot === null) return sql.raw(part);
    const value = condition.values[Number(slot[1])];
    if (value === undefined) throw new Error('UNIT_CONDITION_INVALID');
    return sql.val(value);
  });
  return sql<boolean>`(${sql.join(parts, sql.raw(''))})`;
}
