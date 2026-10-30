import { parseCapabilities } from '../negotiation.js';
import type { Issue } from '../issues.js';
import { SCROLL_DOCUMENT_V2_SCHEMA_VERSION, type ScrollDocumentV2 } from './document.js';
import { validateDocumentV2, type DocumentV2Outcome } from './validate.js';

/**
 * The client path for a `scroll-document.v2` (a device, or a server reading a stored revision to
 * serve it): the size, the schema, the budget and the structure rules, and nothing that costs a
 * hash. The reading measures, the reading time and the integrity hash are checked only with
 * `{verify: true}`, off the render path, exactly as `parseDocument` does for v1. Admission
 * (`validateDocumentV2`) always verifies.
 *
 * Never throws on hostile input; findings carry codes and paths, never the text they are about.
 */
export function parseDocumentV2(input: unknown, options: { readonly verify?: boolean } = {}): DocumentV2Outcome {
  return validateDocumentV2(input, { verify: options.verify === true });
}

export type NegotiationV2Outcome =
  | { readonly kind: 'negotiated'; readonly document: ScrollDocumentV2 }
  | { readonly kind: 'invalid-capabilities'; readonly issues: readonly Issue[] }
  | { readonly kind: 'unsupported-document'; readonly schemaVersion: string };

/**
 * Whether a client can be given a v2 document. A v2 document has no block types to substitute: the
 * client either declares `scroll-document.v2` and renders every stop kind, or it is not offered the
 * document (a v1 revision may stand in for it; that choice is the caller's). The capabilities are
 * untrusted client input and are parsed here. The stored document is returned unchanged, so its
 * integrity hash still names exactly what the client received.
 */
export function negotiateV2(document: ScrollDocumentV2, capabilitiesInput: unknown): NegotiationV2Outcome {
  const parsed = parseCapabilities(capabilitiesInput);
  if (parsed.kind === 'invalid') return { kind: 'invalid-capabilities', issues: parsed.issues };
  if (!parsed.capabilities.documentSchemas.includes(SCROLL_DOCUMENT_V2_SCHEMA_VERSION))
    return { kind: 'unsupported-document', schemaVersion: document.schemaVersion };
  return { kind: 'negotiated', document };
}
