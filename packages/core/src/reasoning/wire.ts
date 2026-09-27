/**
 * The request and reply wire rules every model path shares (Ask answers, bridge inquiries, Scroll
 * writing). No I/O.
 */

/** Stable key order, so equal inputs give equal bytes and therefore an equal reserved hash. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The whole reply, after dropping reasoning blocks, as one JSON object: bare, or as the only content
 * of a single fenced block. Prose around it is not "exactly one JSON object" (ADR-0038 §7). */
export function wholeObject(text: string): Record<string, unknown> | undefined {
  let body = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/.exec(body);
  if (fenced) body = fenced[1]!.trim();
  if (!body.startsWith('{')) return undefined;
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}
