import type { ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { INTERACTION_KINDS, type Block, type ScrollDocument } from '@knowscroll/scroll-model';
import { DisplayProvider, type Display } from '../display/display';
import { scrollFixture, section } from '../scroll/fixtures/build';
import type { ScrollDiagnostics, ScrollReadingObserver } from '../scroll/observer';
import { prepareScrollDocument } from '../scroll/prepare';

/** Helpers for the Scroll block tests: a pinned display, the client parse, recorders and one-block articles. */

export const anyNumber = expect.any(Number) as number;

type DisplayPin = Partial<Pick<Display, 'width' | 'textScale' | 'reducedMotion'>>;

export function wrap(element: ReactElement, display: DisplayPin = {}) {
  return (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true, ...display }}>{element}</DisplayProvider>
  );
}

export function show(element: ReactElement, display: DisplayPin = {}) {
  return render(wrap(element, display));
}

/** A document through the client parse, as the route would hand it over. */
export function ready(document: ScrollDocument): ScrollDocument {
  const prepared = prepareScrollDocument(document);
  if (prepared.kind !== 'ready') throw new Error('the fixture must parse on the client path');
  return prepared.document;
}

export function observerDouble() {
  return {
    onBlockVisibility: jest.fn(),
    onBlockInteraction: jest.fn(
      (event: { blockId: string; blockType: keyof typeof INTERACTION_KINDS; kind: string; at: number }) => {
        expect(INTERACTION_KINDS[event.blockType] as readonly string[]).toContain(event.kind);
        expect(Object.keys(event).sort()).toEqual(['at', 'blockId', 'blockType', 'kind']);
      },
    ),
    onActivity: jest.fn(),
  } satisfies ScrollReadingObserver;
}

export function diagnosticsDouble() {
  return { onRenderFallback: jest.fn() } satisfies ScrollDiagnostics;
}

/** An article of exactly these blocks (poster template), so a test reads one block and nothing else. */
export function articleOf(blocks: Block[], revision = 1): ScrollDocument {
  return ready(
    scrollFixture({
      assetId: 'fixture-one',
      revision,
      template: 'poster',
      family: 'systems',
      kicker: 'Test',
      title: 'One block under test',
      dek: 'A document of a few blocks, made for a test.',
      sections: [section('only', null, blocks)],
    }),
  );
}
