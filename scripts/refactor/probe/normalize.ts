/**
 * Normalization for the HTTP surface probe (issue #196). One Normalizer lives for a whole probe run,
 * so numbering is by first appearance across every case: the recorded output is byte-identical
 * between runs on identical code, and any route/body/header drift still shows as a diff. Only
 * values that differ per run are replaced; statuses, messages, kinds, counts, booleans and array
 * order stay visible.
 */

const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const ISO_TIMESTAMP =
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})\b/g;
// Lookarounds instead of \b: a hex run glued to other word characters (a token, a prefixed key)
// is not a digest and must not be rewritten piecemeal.
const LONG_HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{32,}(?![0-9A-Za-z])/g;
const TIME_KEY = /(?:At|_at|Ms|Time)$/;

export class Normalizer {
  private uuids = new Map<string, number>();
  private hexes = new Map<string, number>();
  private tokens = new Map<string, number>();
  /** Longest first, so a token that contains another is replaced whole. */
  private tokenList: string[] = [];

  /** Rule: opaque credentials (session, CSRF, magic-link tokens) are registered when the probe learns
   * them and replaced wherever they later appear, in any string, as `<token:N>`. */
  registerToken(value: string): void {
    if (value.length < 8 || this.tokens.has(value)) return;
    this.tokens.set(value, this.tokens.size + 1);
    this.tokenList = [...this.tokens.keys()].sort((a, b) => b.length - a.length);
  }

  private string(value: string): string {
    let out = value;
    for (const token of this.tokenList) {
      if (out.includes(token))
        out = out.split(token).join(`<token:${this.tokens.get(token)}>`);
    }
    // Rule: ISO-8601 timestamps carry wall-clock time, never behavior.
    out = out.replace(ISO_TIMESTAMP, '<ts>');
    // Rule: UUIDs are random per run; numbered by first appearance (case-insensitive, so a
    // upper-cased echo of an id keeps the same number and the case difference is not lost either:
    // the number is the identity, case differences are caught by the exact-echo cases' own bodies).
    out = out.replace(UUID, (match) => {
      const key = match.toLowerCase();
      if (!this.uuids.has(key)) this.uuids.set(key, this.uuids.size + 1);
      return match === key
        ? `<uuid:${this.uuids.get(key)}>`
        : `<uuid:${this.uuids.get(key)}:upper>`;
    });
    // Rule: long hex strings (digests, derived CSRF tokens, content addresses) are per-run values.
    out = out.replace(LONG_HEX, (match) => {
      const key = match.toLowerCase();
      if (!this.hexes.has(key)) this.hexes.set(key, this.hexes.size + 1);
      return `<hex:${this.hexes.get(key)}>`;
    });
    return out;
  }

  /** Rule: a numeric value, or a timestamp string, under a key ending At / _at / Ms / Time is a
   * clock reading. Anything else under such a key (null, a boolean, a non-time string) is kept. */
  private isTimeValue(value: unknown): boolean {
    if (typeof value === 'number') return true;
    return (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
    );
  }

  normalize(value: unknown, key?: string): unknown {
    if (key !== undefined && TIME_KEY.test(key) && this.isTimeValue(value))
      return '<time>';
    if (typeof value === 'string') return this.string(value);
    if (Array.isArray(value)) return value.map((item) => this.normalize(item));
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>))
        out[this.string(k)] = this.normalize(v, k);
      return out;
    }
    return value;
  }
}

/** Sorted-key JSON so the output file does not depend on object insertion order. */
export function stableStringify(value: unknown, indent = 2): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.keys(input as object)
          .sort()
          .map((k) => [k, sort((input as Record<string, unknown>)[k])]),
      );
    }
    return input;
  };
  return `${JSON.stringify(sort(value), null, indent)}\n`;
}
