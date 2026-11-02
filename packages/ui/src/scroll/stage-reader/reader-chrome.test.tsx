import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '../../display/display';
import { ReaderDock, ReaderTopBar } from './reader-chrome';
import type { LayoutRectangle } from 'react-native';

/** The reader's top bar and dock (V3 P3, G1). The browser layout at 320, 360 and 390 px is in `apps/client/e2e/reader-nav-smoke.spec.ts`. */
function bar(width: number, title = 'It leans') {
  return render(
    <DisplayProvider value={{ width, textScale: 1, reducedMotion: true }}>
      <ReaderTopBar title={title} onUniverse={jest.fn()} onNextTopic={jest.fn()} />
    </DisplayProvider>,
  );
}

const layout = (y: number, height: number): { nativeEvent: { layout: LayoutRectangle } } => ({
  nativeEvent: { layout: { x: 0, y, width: 100, height } },
});

describe('Next in the top bar', () => {
  it('says its word on a phone while the controls sit beside the title', async () => {
    await bar(390);
    expect(screen.getByText('Next')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next topic' })).toBeOnTheScreen();
  });

  it('says its word from tablet width up, and is its arrow alone at 320 and 360 px', async () => {
    const wide = await bar(834);
    expect(screen.getByText('Next')).toBeOnTheScreen();
    await wide.unmount();
    for (const width of [320, 360]) {
      const small = await bar(width);
      expect(screen.queryByText('Next')).not.toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Next topic' })).toBeOnTheScreen();
      await small.unmount();
    }
  });

  it('takes its word back when the controls would wrap under the title, and keeps it back for that title', async () => {
    const view = await bar(390, 'A title too long to leave room');
    expect(screen.getByText('Next')).toBeOnTheScreen();
    // The controls were laid out wholly below the title: no room.
    await fireEvent(screen.getByTestId('reader-top-title'), 'layout', layout(0, 40));
    await fireEvent(screen.getByTestId('reader-top-controls'), 'layout', layout(48, 44));
    expect(screen.queryByText('Next')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next topic' })).toBeOnTheScreen();
    await view.rerender(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReaderTopBar title="A title too long to leave room" onUniverse={jest.fn()} onNextTopic={jest.fn()} />
      </DisplayProvider>,
    );
    expect(screen.queryByText('Next')).not.toBeOnTheScreen();
  });
});

describe('Next in the top bar, with a title that needs more than two lines beside it', () => {
  it('takes its word back, because the title would be cut', async () => {
    await bar(390, 'A title that needs three lines');
    expect(screen.getByText('Next')).toBeOnTheScreen();
    // Two lines of the title's type, and a little: the title fits.
    await fireEvent(
      screen.getByTestId('reader-top-title-probe', { includeHiddenElements: true }),
      'layout',
      layout(0, 36),
    );
    expect(screen.getByText('Next')).toBeOnTheScreen();
    await fireEvent(
      screen.getByTestId('reader-top-title-probe', { includeHiddenElements: true }),
      'layout',
      layout(0, 80),
    );
    expect(screen.queryByText('Next')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Next topic' })).toBeOnTheScreen();
  });
});

describe('Ask in the dock', () => {
  it('is the blue sparkle on a tinted pill', async () => {
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReaderDock onAsk={jest.fn()} />
      </DisplayProvider>,
    );
    const ask = screen.getByRole('button', { name: 'Ask about this' });
    expect(ask).toBeOnTheScreen();
    expect(ask).toHaveStyle({ backgroundColor: '#F4EDD8' });
  });
});
