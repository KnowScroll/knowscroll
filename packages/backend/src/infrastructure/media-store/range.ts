/** RFC 9110 single byte ranges; unsupported/malformed multi-range requests are refused as 416. */
export function byteRange(
  value: string | undefined,
  size: number,
):
  | { readonly kind: 'full' }
  | { readonly kind: 'range'; readonly start: number; readonly end: number }
  | { readonly kind: 'unsatisfiable' } {
  if (value === undefined) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === '' && match[2] === '')) return { kind: 'unsatisfiable' };
  const first = match[1] ?? '';
  const last = match[2] ?? '';
  if (first === '') {
    const suffix = Number(last);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(size - 1, Number(last));
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end)
    return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}
