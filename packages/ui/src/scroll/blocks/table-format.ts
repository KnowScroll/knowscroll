import { formatNumber } from '../model';

/** Decimal places a number needs, at most four (the package's own format limit). */
function decimalsOf(value: number): number {
  if (Number.isInteger(value)) return 0;
  const [, fraction = ''] = String(Math.abs(value)).split('.');
  return Math.min(4, fraction.length);
}

/** A table number as the reader sees it: grouped thousands, only the decimals it has, U+2212 for minus. */
export function formatCellNumber(value: number): string {
  return formatNumber(value, { decimals: decimalsOf(value), grouping: true, approximate: false });
}
