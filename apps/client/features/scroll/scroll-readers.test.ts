import spring from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocument, ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { SCROLL_CAPABILITIES, SCROLL_V2_CAPABILITIES } from './capabilities';
import {
  ARTICLE_ONLY,
  capabilitiesFor,
  EVERY_READER,
  EVERY_READER_FOLIO,
  readerFor,
  v2ReaderOf,
} from './scroll-readers';

const article = { document: spring as unknown as ScrollDocument };
const essay = { document: seasons as unknown as ScrollDocumentV2 };

describe('which reader draws a Scroll (scroll-readers.ts)', () => {
  it('draws v1 with the article and v2 with the Stage reader by default', () => {
    expect(readerFor(article, EVERY_READER)?.reader).toBe('article');
    expect(readerFor(essay, EVERY_READER)?.reader).toBe('stage');
  });

  it('draws v2 with Folio only on a device that chose it, and v1 with the article either way', () => {
    expect(readerFor(essay, EVERY_READER_FOLIO)?.reader).toBe('folio');
    expect(readerFor(article, EVERY_READER_FOLIO)?.reader).toBe('article');
    expect(v2ReaderOf(EVERY_READER)).toBe('stage');
    expect(v2ReaderOf(EVERY_READER_FOLIO)).toBe('folio');
  });

  it('draws nothing a screen does not offer: a v2 Scroll on a v1-only screen needs an update', () => {
    expect(readerFor(essay, ARTICLE_ONLY)).toBeUndefined();
  });

  it('returns the same Scroll it was given, so screens can keep it by identity', () => {
    expect(readerFor(essay, EVERY_READER)?.scroll).toBe(essay);
  });

  it('declares v2 for any screen with a v2 reader, the same whichever reader it is', () => {
    expect(capabilitiesFor(EVERY_READER)).toBe(SCROLL_V2_CAPABILITIES);
    expect(capabilitiesFor(EVERY_READER_FOLIO)).toBe(SCROLL_V2_CAPABILITIES);
    expect(capabilitiesFor(ARTICLE_ONLY)).toBe(SCROLL_CAPABILITIES);
  });
});
