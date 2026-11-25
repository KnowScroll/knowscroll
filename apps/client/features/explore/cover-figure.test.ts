import seasonsPictures from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { coverFrameOfV3, describePicture, type ScrollDocumentV3, type StageFrame } from '@knowscroll/scroll-model';
import type { CoveredOffer } from '../encounter/encounter-session';
import { coverFigureOf } from './cover-figure';

/** A stored stage frame as an older server sends one in `offer-cover.v1`: Earth & sky's words, a kit no code draws any more. */
const stageFrame: StageFrame = {
  kit: 'earth-sky.v1',
  state: { view: 'sun-earth', earthAt: 'jun', moonAt: 'off', focus: 'axis' },
  alt: 'CI fixture: the Sun on the left, Earth on the right, in June.',
};
const pictureFrame = coverFrameOfV3(seasonsPictures as unknown as ScrollDocumentV3);
if (pictureFrame === undefined) throw new Error('the fixture shows a picture');

function offerWith(cover: Partial<CoveredOffer['cover']>): CoveredOffer {
  return {
    offerId: '0199a000-0000-7000-8000-000000000101',
    cover: { version: 'offer-cover.v2', kicker: 'CI cover', readingMinutes: 4, ...cover },
  } as CoveredOffer;
}

describe('the figure a cover shows (cover-figure.ts)', () => {
  it('draws a picture frame as a picture figure with its own words, named for the offer', () => {
    const figure = coverFigureOf(offerWith({ figure: pictureFrame }));
    if (figure?.kind !== 'picture') throw new Error('expected a picture figure');
    expect(figure.picture).toBe(pictureFrame.picture);
    expect(figure.state).toBe(pictureFrame.state);
    expect(figure.alt).toBe(describePicture(pictureFrame.picture, pictureFrame.state));
    expect(figure.key).toBe('cover-0199a000-0000-7000-8000-000000000101');
  });

  it.each([
    'transit.v1',
    'tides.v1',
    'star.v1',
    'greenhouse.v1',
    'circulation.v1',
    'nerve.v1',
    'black-hole.v1',
    'starlight.v1',
    'earth-sky.v1',
    'gone.v1',
  ])('draws nothing for a stored stage frame of %s, which no code draws any more, and does not throw', (kit) => {
    expect(coverFigureOf(offerWith({ version: 'offer-cover.v1', figure: { ...stageFrame, kit } }))).toBeUndefined();
    expect(coverFigureOf(offerWith({ version: 'offer-cover.v2', figure: { ...stageFrame, kit } }))).toBeUndefined();
  });

  it('draws nothing for a cover with no figure', () => {
    expect(coverFigureOf(offerWith({}))).toBeUndefined();
  });
});
