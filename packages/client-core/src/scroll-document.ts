import {
  parseDocument,
  parseDocumentV2,
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  type Issue,
  type IssueV2,
  type ScrollDocument,
  type ScrollDocumentV2,
} from '@knowscroll/scroll-model';

export { parseDocumentV2 };

/** A Scroll document the device can read, whichever schema the server sent. */
export type ParsedScrollDocument =
  | { readonly kind: 'valid'; readonly schema: 'v1'; readonly document: ScrollDocument }
  | { readonly kind: 'valid'; readonly schema: 'v2'; readonly document: ScrollDocumentV2 }
  | { readonly kind: 'unsupported'; readonly schemaVersion: string | null }
  | { readonly kind: 'invalid'; readonly issues: readonly (Issue | IssueV2)[] };

/**
 * The client's way into an exposure's document: the same trust boundary for both schemas. The schema
 * the server named picks the parser (`parseDocument` or `parseDocumentV2`); each checks structure, bounds
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
