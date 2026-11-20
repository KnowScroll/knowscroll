import type { ClientCapabilities } from '@knowscroll/contracts';
import {
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  SCROLL_DOCUMENT_V3_SCHEMA_VERSION,
  type ScrollDocument,
  type ScrollDocumentV2,
  type ScrollDocumentV3,
} from '@knowscroll/scroll-model';
import { SCROLL_CAPABILITIES, SCROLL_FOLIO_CAPABILITIES } from './capabilities';

/**
 * The readers that draw a Scroll: the article draws `scroll-document.v1`; Folio's essay draws `scroll-document.v2` and
 * `scroll-document.v3` (D-425, #762). Which one draws an opened Scroll is decided by `readerFor` and nowhere else; a screen says which readers it
 * offers and switches on the answer.
 */
export type ScrollReaderKind = 'article' | 'folio';

/** Every reader a screen can draw any Scroll with. */
export const EVERY_READER: readonly ScrollReaderKind[] = ['article', 'folio'];

/** The article alone, for a screen that draws only v1 documents (a What-if branch). */
export const ARTICLE_ONLY: readonly ScrollReaderKind[] = ['article'];

interface WithDocument {
  readonly document: ScrollDocument | ScrollDocumentV2 | ScrollDocumentV3;
}

/** An opened Scroll with the reader that draws it; switching on `reader` narrows the document too. */
export type ScrollToDraw<Scroll extends WithDocument> =
  | { readonly reader: 'article'; readonly scroll: Scroll & { readonly document: ScrollDocument } }
  | { readonly reader: 'folio'; readonly scroll: Scroll & { readonly document: ScrollDocumentV2 | ScrollDocumentV3 } };

/** The reader that draws this Scroll among those the screen offers, or none (the screen then says it needs an update). */
export function readerFor<Scroll extends WithDocument>(
  scroll: Scroll,
  offered: readonly ScrollReaderKind[],
): ScrollToDraw<Scroll> | undefined {
  // The same object, narrowed: screens and sessions keep a Scroll by identity.
  if (
    scroll.document.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION ||
    scroll.document.schemaVersion === SCROLL_DOCUMENT_V3_SCHEMA_VERSION
  ) {
    return offered.includes('folio')
      ? { reader: 'folio', scroll: scroll as Scroll & { readonly document: ScrollDocumentV2 | ScrollDocumentV3 } }
      : undefined;
  }
  return offered.includes('article')
    ? { reader: 'article', scroll: scroll as Scroll & { readonly document: ScrollDocument } }
    : undefined;
}

/**
 * What a screen offering these readers declares when it opens a Scroll (D-012, D-129): the server sends a document
 * only in a version one of them draws.
 */
export function capabilitiesFor(offered: readonly ScrollReaderKind[]): ClientCapabilities {
  return offered.includes('folio') ? SCROLL_FOLIO_CAPABILITIES : SCROLL_CAPABILITIES;
}
