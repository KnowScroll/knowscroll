import { fireEvent, render, screen } from '@testing-library/react-native';
import pictureDocument from '@knowscroll/scroll-model/fixtures/seasons-v3-ci.json';
import stopsDocument from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import { DisplayProvider } from '@knowscroll/ui';
import { MadeToOrderContext, type MadeToOrderState } from '../../providers/made-to-order';
import { ScrollReaderSurface, type ReaderMoves } from './scroll-reader-surface';
import type { OpenedScrollFolio } from './scroll-session';

/**
 * Ask from here is a way into a Scroll made to order, so the reader offers it only while the API says those are on (D-436).
 * Every other row of the ••• sheet stays, and the sheet closes up without a gap where Ask was.
 */
const opened = (document: unknown): OpenedScrollFolio =>
  ({
    exposureId: '0199a000-0000-7000-8000-000000000004',
    assetId: '0199a000-0000-7000-8000-000000000005',
    assetRevision: 1,
    document,
  }) as unknown as OpenedScrollFolio;

const moves = (over: Partial<ReaderMoves> = {}): ReaderMoves => ({
  universe: jest.fn(),
  ask: jest.fn(),
  makeScroll: jest.fn(),
  ...over,
});

async function show(document: unknown, state: MadeToOrderState, over: Partial<ReaderMoves> = {}) {
  const given = moves(over);
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <MadeToOrderContext.Provider value={state}>
        <ScrollReaderSurface scroll={opened(document)} moves={given} topInset={0} bottomInset={0} />
      </MadeToOrderContext.Provider>
    </DisplayProvider>,
  );
  await fireEvent.press(screen.getByTestId('dock-more'));
  return given;
}

const documents = [
  ['a v2 Scroll', stopsDocument],
  ['a document v3 Scroll', pictureDocument],
] as const;

describe.each(documents)('the ••• sheet of %s and the made-to-order switch', (_name, document) => {
  it('has the Ask about this row, first, while the switch is on', async () => {
    const given = await show(document, 'on');
    const ask = screen.getByTestId('more-ask');
    expect(ask).toHaveAccessibleName('Ask about this');
    await fireEvent.press(ask);
    expect(given.ask).toHaveBeenCalledTimes(1);
  });

  for (const state of ['off', 'unknown'] as const)
    it(`has no Ask about this row while the switch is ${state}, and keeps the rows that are not made to order`, async () => {
      await show(document, state);
      expect(screen.queryByTestId('more-ask')).toBeNull();
      expect(screen.queryByTestId('more-ask-detail')).toBeNull();
      expect(screen.getByTestId('more-simpler')).toBeOnTheScreen();
      expect(screen.getByTestId('more-report')).toBeOnTheScreen();
    });
});
