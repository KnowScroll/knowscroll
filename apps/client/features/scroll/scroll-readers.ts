import type { ClientCapabilities } from '@knowscroll/contracts';
import {
  SCROLL_DOCUMENT_V2_SCHEMA_VERSION,
  type ScrollDocument,
  type ScrollDocumentV2,
} from '@knowscroll/scroll-model';
import { SCROLL_CAPABILITIES, SCROLL_V2_CAPABILITIES } from './capabilities';

/**
 * The readers that draw a Scroll: the article draws `scroll-document.v1`; the Stage + Spine reader and Folio's essay
 * draw `scroll-document.v2`. Which one draws an opened Scroll is decided by `readerFor` and nowhere else; a screen says
 * which readers it offers (`useScrollReaders`) and switches on the answer.
 */
export type ScrollReaderKind = 'article' | 'stage' | 'folio';

/** A reader of `scroll-document.v2`. */
export type ScrollV2Reader = Extract<ScrollReaderKind, 'stage' | 'folio'>;

/** Every reader a screen can draw any Scroll with, the v2 one being the Stage reader. */
export const EVERY_READER: readonly ScrollReaderKind[] = ['article', 'stage'];

/** The same, with Folio drawing v2 (the trial, #732). */
export const EVERY_READER_FOLIO: readonly ScrollReaderKind[] = ['article', 'folio'];

/** The article alone, for a screen that draws only v1 documents (a What-if branch). */
export const ARTICLE_ONLY: readonly ScrollReaderKind[] = ['article'];

interface WithDocument {
  readonly document: ScrollDocument | ScrollDocumentV2;
}

/** An opened Scroll with the reader that draws it; switching on `reader` narrows the document too. */
export type ScrollToDraw<Scroll extends WithDocument> =
  | { readonly reader: 'article'; readonly scroll: Scroll & { readonly document: ScrollDocument } }
  | { readonly reader: ScrollV2Reader; readonly scroll: Scroll & { readonly document: ScrollDocumentV2 } };

/** The reader that draws this Scroll among those the screen offers, or none (the screen then says it needs an update). */
export function readerFor<Scroll extends WithDocument>(
  scroll: Scroll,
  offered: readonly ScrollReaderKind[],
): ScrollToDraw<Scroll> | undefined {
  // The same object, narrowed: screens and sessions keep a Scroll by identity.
  if (scroll.document.schemaVersion === SCROLL_DOCUMENT_V2_SCHEMA_VERSION) {
    return offered.includes('stage') || offered.includes('folio')
      ? { reader: v2ReaderOf(offered), scroll: scroll as Scroll & { readonly document: ScrollDocumentV2 } }
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
  return offered.includes('stage') || offered.includes('folio') ? SCROLL_V2_CAPABILITIES : SCROLL_CAPABILITIES;
}

/** The v2 reader among those offered: Folio when the device chose it, else the Stage reader. */
export function v2ReaderOf(offered: readonly ScrollReaderKind[]): ScrollV2Reader {
  return offered.includes('folio') ? 'folio' : 'stage';
}
