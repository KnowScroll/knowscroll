import {
  parseDocument,
  type DocumentOutcome,
  type Issue,
  type ScrollDocument,
  walkBlocks,
} from '@knowscroll/scroll-model';

export type PreparedScroll =
  | { readonly kind: 'ready'; readonly document: ScrollDocument }
  | { readonly kind: 'unsupported-version'; readonly schemaVersion: string | null }
  | { readonly kind: 'invalid'; readonly issues: readonly Issue[] };

/** Blocks that came out of `parseDocument`: the article need not parse them again. */
const parsedBlocks = new WeakSet<object>();

export function isParsedBlock(block: object): boolean {
  return parsedBlocks.has(block);
}

/**
 * The client's way into a document: `parseDocument` (structure, bounds and the cheap checks; the
 * grid proof is the server's admission and never runs on the device) and nothing else. The
 * reading measures and the hash are checked only when `verify` is asked for, off the render path.
 * A document that is not `ready` is not rendered: the route shows its own state (and may offer
 * the Reel variant); a rendition of a valid revision is always valid, so this means a corrupted
 * or newer document, not a server choice.
 */
export function prepareScrollDocument(input: unknown, options: { readonly verify?: boolean } = {}): PreparedScroll {
  const outcome: DocumentOutcome = parseDocument(input, options);
  if (outcome.kind === 'unsupported-version')
    return { kind: 'unsupported-version', schemaVersion: outcome.schemaVersion };
  if (outcome.kind === 'invalid') return { kind: 'invalid', issues: outcome.issues };
  for (const { block } of walkBlocks(outcome.document.sections)) parsedBlocks.add(block);
  return { kind: 'ready', document: outcome.document };
}
