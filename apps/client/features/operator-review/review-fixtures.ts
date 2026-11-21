import broadStreet from '@knowscroll/scroll-model/fixtures/broad-street-v3-ci.json';
import { coverFrameOfV3, type ScrollDocumentV3 } from '@knowscroll/scroll-model';
import type { ReviewListItem, ReviewShow } from '@knowscroll/contracts';

/**
 * Labelled fixtures for the review screens' tests: the CI Broad Street document v3 and the answers the routes would give for it. Authored
 * here, so a test proves what the screen draws and sends, not what the server decides (the integration test is the server).
 */
export const FIXTURE_ASSET = '0199a000-0000-7000-8000-0000000000aa';
export const OTHER_ASSET = '0199a000-0000-7000-8000-0000000000bb';
export const fixtureDocument = broadStreet as unknown as ScrollDocumentV3;

const frame = coverFrameOfV3(fixtureDocument);

export function fixtureListItem(overrides: Partial<ReviewListItem> = {}): ReviewListItem {
  return {
    assetId: FIXTURE_ASSET,
    revision: 1,
    title: fixtureDocument.title,
    kicker: 'Fixture',
    documentVersion: 'scroll-document.v3',
    heldAt: '2026-11-21T09:30:00.000Z',
    recipe: 'broad-street',
    topic: 'earth.cholera',
    coverage: 'mapped',
    readingMinutes: 3,
    answerCheck: null,
    supportCheck: 'flagged',
    ...overrides,
  };
}

export function fixtureShow(overrides: Partial<ReviewShow> = {}): ReviewShow {
  return {
    assetId: FIXTURE_ASSET,
    revision: 1,
    heldAt: '2026-11-21T09:30:00.000Z',
    recipe: 'broad-street',
    topic: 'earth.cholera',
    coverage: 'mapped',
    document: fixtureDocument,
    cover: {
      version: 'offer-cover.v2',
      kicker: 'Fixture',
      readingMinutes: 3,
      readStops: 13,
      ...(frame === undefined ? {} : { figure: frame }),
    },
    parts: [
      {
        partId: 'b1',
        passages: [{ quote: 'The first cases came on the last night of August.', source: 'A labelled fixture page' }],
      },
      { partId: 'a1', passages: [{ quote: 'The plan was drawn by hand.', source: 'Another fixture page' }] },
      {
        partId: 'soho',
        passages: [{ quote: 'Soho lay within a short walk of the pump.', source: 'A labelled fixture page' }],
      },
      { partId: 'takeaway', passages: [{ quote: 'The pump handle was removed.', source: 'A labelled fixture page' }] },
    ],
    answerCheck: null,
    supportCheck: {
      verdict: 'flagged',
      checker: 'library-support.v1',
      policy: 'library-support-policy.v1',
      code: null,
      counts: { sentences: 40, supported: 36, unsupported: 1, unclear: 1, noClaim: 2 },
      attention: [
        {
          partId: 'b2',
          field: 'paragraph',
          n: 7,
          outcome: 'unsupported',
          text: 'Five hundred people died in ten days.',
          problem: 'The passages give a smaller count.',
        },
      ],
    },
    ...overrides,
  };
}
