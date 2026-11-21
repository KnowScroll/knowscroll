import seasonsStage from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import seasonsPictures from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { coverFrameOfV3, describePicture, firstFrameOf, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import type { CoveredOffer } from '../encounter/encounter-session';
import { coverFigureOf } from './cover-figure';

const stageFrame = firstFrameOf(seasonsStage);
const pictureFrame = coverFrameOfV3(seasonsPictures as unknown as ScrollDocumentV3);
if (stageFrame === undefined || pictureFrame === undefined) throw new Error('the fixtures show a picture');

function offerWith(cover: Partial<CoveredOffer['cover']>): CoveredOffer {
  return {
    offerId: '0199a000-0000-7000-8000-000000000101',
    cover: { version: 'offer-cover.v2', kicker: 'CI cover', readingMinutes: 4, ...cover },
  } as CoveredOffer;
}

describe('the figure a cover shows (cover-figure.ts)', () => {
  it('draws a stage frame, which has a kit, as a kit figure named for the offer', () => {
    const figure = coverFigureOf(offerWith({ version: 'offer-cover.v1', figure: stageFrame }));
    expect(figure).toEqual({
      kind: 'state',
      kit: stageFrame.kit,
      state: stageFrame.state,
      alt: stageFrame.alt,
      key: 'cover-0199a000-0000-7000-8000-000000000101',
    });
  });

  it('draws a picture frame as a picture figure with its own words, named for the offer', () => {
    const figure = coverFigureOf(offerWith({ figure: pictureFrame }));
    if (figure?.kind !== 'picture') throw new Error('expected a picture figure');
    expect(figure.picture).toBe(pictureFrame.picture);
    expect(figure.state).toBe(pictureFrame.state);
    expect(figure.alt).toBe(describePicture(pictureFrame.picture, pictureFrame.state));
    expect(figure.key).toBe('cover-0199a000-0000-7000-8000-000000000101');
  });

  it.each(['gone.v1', 'constructor', '__proto__'])(
    'draws nothing for a stage frame of a kit this build does not draw (%s), and does not throw',
    (kit) => {
      const frame = { kit, state: { old: 'word' }, alt: 'What the removed kit drew.' } as unknown as typeof stageFrame;
      expect(coverFigureOf(offerWith({ version: 'offer-cover.v1', figure: frame }))).toBeUndefined();
    },
  );

  it('draws nothing for a cover with no figure', () => {
    expect(coverFigureOf(offerWith({}))).toBeUndefined();
  });
});
