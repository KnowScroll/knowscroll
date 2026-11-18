import spring from '@knowscroll/scroll-model/fixtures/spring-neap-tides.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocument, ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { SCROLL_CAPABILITIES, SCROLL_V2_CAPABILITIES } from './capabilities';
import { ARTICLE_ONLY, capabilitiesFor, EVERY_READER, readerFor } from './scroll-readers';

const article = { document: spring as unknown as ScrollDocument };
const essay = { document: seasons as unknown as ScrollDocumentV2 };

describe('which reader draws a Scroll (scroll-readers.ts)', () => {
  it('draws v1 with the article and v2 with Folio', () => {
    expect(readerFor(article, EVERY_READER)?.reader).toBe('article');
    expect(readerFor(essay, EVERY_READER)?.reader).toBe('folio');
  });

  it('draws nothing a screen does not offer: a v2 Scroll on a v1-only screen needs an update', () => {
    expect(readerFor(essay, ARTICLE_ONLY)).toBeUndefined();
  });

  it('returns the same Scroll it was given, so screens can keep it by identity', () => {
    expect(readerFor(essay, EVERY_READER)?.scroll).toBe(essay);
  });

  it('declares v2 only for a screen that draws it', () => {
    expect(capabilitiesFor(EVERY_READER)).toBe(SCROLL_V2_CAPABILITIES);
    expect(capabilitiesFor(ARTICLE_ONLY)).toBe(SCROLL_CAPABILITIES);
  });
});
