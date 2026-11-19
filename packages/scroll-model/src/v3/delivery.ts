import type { Issue } from '../issues.js';
import { parseCapabilities } from '../negotiation.js';
import { SCROLL_DOCUMENT_V3_SCHEMA_VERSION, type ScrollDocumentV3 } from './document.js';
import { validateDocumentV3, type DocumentV3Outcome } from './validate.js';

/**
 * The client path for a `scroll-document.v3` (a device, or a server reading a stored revision to serve it): the size,
 * the schema, the budget and the rules, and nothing that costs a hash. The reading measures, the reading time and the
 * integrity hash are checked only with `{verify: true}`, off the render path, as `parseDocument` and
 * `parseDocumentV2` do. Admission (`validateDocumentV3`) always verifies.
 *
 * Never throws on hostile input; findings carry codes and paths, never the text they are about.
 */
export function parseDocumentV3(input: unknown, options: { readonly verify?: boolean } = {}): DocumentV3Outcome {
  return validateDocumentV3(input, { verify: options.verify === true });
}

export type NegotiationV3Outcome =
  | { readonly kind: 'negotiated'; readonly document: ScrollDocumentV3 }
  | { readonly kind: 'invalid-capabilities'; readonly issues: readonly Issue[] }
  | { readonly kind: 'unsupported-document'; readonly schemaVersion: string };

/**
 * Whether a client can be given a v3 document. A v3 document has no blocks to substitute: the client either declares
 * `scroll-document.v3` and draws every picture kind, or it is not offered the document (an earlier revision may
 * stand in for it; that choice is the caller's, D-129). The capabilities are untrusted client input and are parsed
 * here. The stored document is returned unchanged, so its integrity hash still names exactly what the client received.
 */
export function negotiateV3(document: ScrollDocumentV3, capabilitiesInput: unknown): NegotiationV3Outcome {
  const parsed = parseCapabilities(capabilitiesInput);
  if (parsed.kind === 'invalid') return { kind: 'invalid-capabilities', issues: parsed.issues };
  if (!parsed.capabilities.documentSchemas.includes(SCROLL_DOCUMENT_V3_SCHEMA_VERSION))
    return { kind: 'unsupported-document', schemaVersion: document.schemaVersion };
  return { kind: 'negotiated', document };
}
