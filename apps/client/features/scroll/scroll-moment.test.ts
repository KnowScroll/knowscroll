import seasonsV3 from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import seasonsV2 from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { beatsOfV3, type ScrollDocumentV2, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { momentOfPlace, whyNoMomentAt } from './scroll-moment';
import type { OpenedScrollFolio } from './scroll-session';

const open = (document: ScrollDocumentV2 | ScrollDocumentV3) =>
  ({ assetId: 'asset', assetRevision: 1, document }) as unknown as OpenedScrollFolio;

const pictured = seasonsV3 as unknown as ScrollDocumentV3;
const essay = seasonsV2 as unknown as ScrollDocumentV2;
const beat = beatsOfV3(pictured)[0]!;

describe('a place of a Folio Scroll as a moment (scroll-moment.ts)', () => {
  describe('a v3 Scroll', () => {
    it('shares a beat as a moment whose id is the beat and whose words are the beat’s', () => {
      expect(momentOfPlace(open(pictured), beat.id)).toEqual({ stopId: beat.id, quote: beat.text });
      expect(whyNoMomentAt(open(pictured), beat.id)).toBeUndefined();
    });

    it('shares every beat: it has no call whose answer a card could give away', () => {
      for (const each of beatsOfV3(pictured)) expect(whyNoMomentAt(open(pictured), each.id)).toBeUndefined();
    });

    it('says there is no stop on screen at the end of the Scroll, or when the reader names a place it does not have', () => {
      expect(whyNoMomentAt(open(pictured), undefined)).toBe('no_stop');
      expect(whyNoMomentAt(open(pictured), 'not-a-beat')).toBe('no_stop');
      expect(momentOfPlace(open(pictured), 'not-a-beat')).toBeUndefined();
    });
  });

  describe('a v2 Scroll', () => {
    const call = essay.stops.find((stop) => stop.kind !== 'read')!;
    const read = essay.stops.find((stop) => stop.kind === 'read')!;

    it('is unchanged: a read stop is a moment and a call is not', () => {
      expect(momentOfPlace(open(essay), read.id)?.stopId).toBe(read.id);
      expect(whyNoMomentAt(open(essay), read.id)).toBeUndefined();
      expect(momentOfPlace(open(essay), call.id)).toBeUndefined();
      expect(whyNoMomentAt(open(essay), call.id)).toBe('call');
      expect(whyNoMomentAt(open(essay), undefined)).toBe('no_stop');
    });
  });
});
