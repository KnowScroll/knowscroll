import seasonsV3 from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import { beatsOfV3, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import { reportTargetOf } from './report-target';
import type { OpenedScrollFolio } from './scroll-session';

const document = seasonsV3 as unknown as ScrollDocumentV3;
const scroll = { assetId: 'asset-1', assetRevision: 4, document } as unknown as OpenedScrollFolio;
const beatId = beatsOfV3(document)[1]!.id;

describe('what a report from a Folio Scroll is about (report-target.ts)', () => {
  it('names the beat on screen of a v3 Scroll, with the exact revision', () => {
    expect(reportTargetOf(scroll, beatId)).toEqual({
      kind: 'asset',
      assetId: 'asset-1',
      assetRevision: 4,
      title: document.title,
      format: 'scroll',
      anchor: { kind: 'scroll', blockId: beatId },
    });
  });

  it('names no place at the end of the Scroll, where nothing is on screen', () => {
    expect(reportTargetOf(scroll, undefined)).not.toHaveProperty('anchor');
  });

  it('names the Quick answer a report is about', () => {
    expect(reportTargetOf(scroll, beatId, 'answer-1')).toMatchObject({
      anchor: { kind: 'scroll', blockId: beatId },
      quickAnswerId: 'answer-1',
    });
  });
});
