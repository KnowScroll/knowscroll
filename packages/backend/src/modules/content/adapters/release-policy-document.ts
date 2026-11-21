import { parseDocumentV2, parseDocumentV3 } from '@knowscroll/scroll-model';
import { proseOf } from '../domain/release-policy.js';
import { NON_PROSE_KEYS_V3 } from '../domain/release-sensitive-data.js';

/**
 * What the release policy reads of a stored Scroll document (D-418, D-435): whether it parses as a document the policy can judge, and the words a
 * reader (or an operator) would read in it. A document v2 and a document v3 are both judged, each under its own schema's parse; a v1 document, a
 * document that does not parse and anything else is unreadable and stays held for a person. Reads nothing but the document it is given.
 */
export interface PolicyDocument {
  /** The document parses on the client path as a v2 or a v3 Scroll. */
  readonly readable: boolean;
  /** Every string of its own fields that is words (`proseOf`); empty when the document is unreadable. */
  readonly prose: string;
}

export function policyDocumentOf(stored: unknown): PolicyDocument {
  const v2 = parseDocumentV2(stored);
  if (v2.kind === 'valid') return { readable: true, prose: proseOf(v2.document) };
  // A document v3 is read with its own list of keys that are not words (its parts refer to one another by id); a v2's list is as it was.
  const v3 = parseDocumentV3(stored);
  if (v3.kind === 'valid') return { readable: true, prose: proseOf(v3.document, NON_PROSE_KEYS_V3) };
  return { readable: false, prose: '' };
}
