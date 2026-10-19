import { sha256Hex } from './sha256.js';

/**
 * `canonical-json.v1`: JSON with object keys sorted by UTF-16 code units, no whitespace, and
 * ECMAScript number and string serialisation (the ordering and number rules of RFC 8785).
 * `undefined` members are omitted, as `JSON.stringify` does. Anything that is not a JSON value
 * (functions, symbols, bigints, non-finite numbers, class instances other than plain objects and
 * arrays) is refused, so a hash can never silently cover a lossy serialisation.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
      const prototype: unknown = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('canonicalJson: not a plain object');
      }
      const record = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        const member = record[key];
        if (member === undefined) continue;
        members.push(`${JSON.stringify(key)}:${canonicalJson(member)}`);
      }
      return `{${members.join(',')}}`;
    }
    case 'undefined':
    case 'bigint':
    case 'symbol':
    case 'function':
      break;
  }
  throw new TypeError(`canonicalJson: ${typeof value} is not a JSON value`);
}

/** UTF-8 byte length of a string (lone surrogates count as U+FFFD, as `TextEncoder` writes them). */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function canonicalSize(value: unknown): number {
  return utf8ByteLength(canonicalJson(value));
}

export function canonicalSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
