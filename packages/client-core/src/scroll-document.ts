import {
  parseDocument,
  parseDocumentV2,
  parseDocumentV3,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  type Issue,
  type IssueV2,
  type IssueV3,
  type ScrollDocument,
  type ScrollDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';

export { parseDocumentV2, parseDocumentV3 };

/** A Scroll document the device can read, whichever schema the server sent. */
export type ParsedScrollDocument =
  | { readonly kind: 'valid'; readonly schema: 'v1'; readonly document: ScrollDocument }
  | { readonly kind: 'valid'; readonly schema: 'v2'; readonly document: ScrollDocumentV2 }
  | { readonly kind: 'valid'; readonly schema: 'v3'; readonly document: ScrollDocumentV3 }
  | { readonly kind: 'unsupported'; readonly schemaVersion: string | null }
  | { readonly kind: 'invalid'; readonly issues: readonly (Issue | IssueV2 | IssueV3)[] };

/**
 * The client's way into an exposure's document: the same trust boundary for every schema. The schema
 * the server named picks the parser (`parseDocument`, `parseDocumentV2` or `parseDocumentV3`); each checks structure, bounds
 * and the cheap rules, and leaves the reading measures and the hash alone unless `verify` is asked for.
 * What the server proved at admission (simulations, claims) is not repeated on the device.
 *
 * A document that is not `valid` is not rendered. Never throws on hostile input.
 */
export function parseScrollDocument(input: unknown, options: { readonly verify?: boolean } = {}): ParsedScrollDocument {
  const named = (input as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (named === SCROLL_DOCUMENT_V2_SCHEMA_VERSION) {
    const parsed = parseDocumentV2(input, options);
    return parsed.kind === 'valid'
      ? { kind: 'valid', schema: 'v2', document: parsed.document }
      : { kind: 'invalid', issues: parsed.issues };
  }
  if (named === SCROLL_DOCUMENT_V3_SCHEMA_VERSION) {
    const parsed = parseDocumentV3(input, options);
    return parsed.kind === 'valid'
      ? { kind: 'valid', schema: 'v3', document: parsed.document }
      : { kind: 'invalid', issues: parsed.issues };
  }
  const parsed = parseDocument(input, options);
  switch (parsed.kind) {
    case 'valid':
      return { kind: 'valid', schema: 'v1', document: parsed.document };
    case 'unsupported-version':
      return { kind: 'unsupported', schemaVersion: parsed.schemaVersion };
    case 'invalid':
      return { kind: 'invalid', issues: parsed.issues };
  }
}
