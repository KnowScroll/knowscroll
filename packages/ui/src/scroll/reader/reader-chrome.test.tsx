import { fireEvent, render, screen } from '@testing-library/react-native';
import { expectPressed } from '../../test-support/render';
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
  it('returns to the opener instead of Universe when the screen supplies Back', async () => {
    const back = jest.fn();
    const universe = jest.fn();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ReaderTopBar title="A shared Scroll" onUniverse={universe} onBack={back} />
      </DisplayProvider>,
    );
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(back).toHaveBeenCalledTimes(1);
    expect(universe).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Your Universe' })).not.toBeOnTheScreen();
  });

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

function dock(width: number, props: Parameters<typeof ReaderDock>[0], textScale = 1) {
  return render(
    <DisplayProvider value={{ width, textScale, reducedMotion: true }}>
      <ReaderDock {...props} />
    </DisplayProvider>,
  );
}

const nextPart = { label: 'Part 2', title: 'How tides work', onPress: jest.fn() };

describe('the dock (D-429)', () => {
  it('is Like, Share and Save, then ••• and the next Part, with a small word under each glyph and no Ask', async () => {
    await dock(390, {
      like: { on: false, onPress: jest.fn() },
      share: { onPress: jest.fn(), what: 'moment' },
      save: { on: false, onPress: jest.fn() },
      onMore: jest.fn(),
      nextPart,
    });
    // Like and Save are toggle buttons; the rest are plain buttons.
    expectPressed(screen.getByRole('togglebutton', { name: 'Like' }), false);
    expect(screen.getByRole('button', { name: 'Share a moment' })).toBeOnTheScreen();
    expectPressed(screen.getByRole('togglebutton', { name: 'Save' }), false);
    expect(screen.getByRole('button', { name: 'More' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Part 2: How tides work' })).toBeOnTheScreen();
    for (const word of ['Like', 'Share', 'Save', 'More'])
      expect(screen.getByText(word, { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Ask/ })).not.toBeOnTheScreen();
  });

  it('presses Like and Save as toggles that announce their state and keep their word', async () => {
    const like = jest.fn();
    const save = jest.fn();
    await dock(390, { like: { on: true, onPress: like }, save: { on: false, onPress: save } });
    expectPressed(screen.getByRole('togglebutton', { name: 'Like' }), true);
    expectPressed(screen.getByRole('togglebutton', { name: 'Save' }), false);
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Like' }));
    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Save' }));
    expect(like).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    // The word under the glyph does not change with the state (WCAG 2.5.3).
    expect(screen.getByText('Like', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByText('Save', { includeHiddenElements: true })).toBeOnTheScreen();
  });

  it('shows a Save that is in flight as busy and inert', async () => {
    await dock(390, { save: { on: false, busy: true, onPress: jest.fn() } });
    // The button itself takes no press while busy (the host element has no handler; `IconButton` tests the press).
    expect(screen.getByRole('togglebutton', { name: 'Save' })).toBeBusy();
    expect(screen.getByRole('togglebutton', { name: 'Save' })).toHaveProp('pointerEvents', 'none');
  });

  it('shares the whole Scroll where the stop on screen cannot be a moment: never disabled, and its name says which', async () => {
    const share = jest.fn();
    await dock(390, { share: { onPress: share, what: 'scroll' } });
    expect(screen.queryByRole('button', { name: /^Share a moment/ })).not.toBeOnTheScreen();
    const button = screen.getByRole('button', { name: 'Share this Scroll' });
    expect(button).toBeEnabled();
    // The word under the glyph stays "Share" (WCAG 2.5.3: it is in the name).
    expect(screen.getByText('Share', { includeHiddenElements: true })).toBeOnTheScreen();
    await fireEvent.press(button);
    expect(share).toHaveBeenCalledTimes(1);
  });

  it('shares the moment when Share is pressed on a stop that can be one', async () => {
    const share = jest.fn();
    await dock(390, { share: { onPress: share, what: 'moment' } });
    await fireEvent.press(screen.getByRole('button', { name: 'Share a moment' }));
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("leaves out what the screen cannot do: a thread's reader has no Like and no Save", async () => {
    await dock(390, { share: { onPress: jest.fn(), what: 'moment' }, onMore: jest.fn() });
    expect(screen.queryByRole('togglebutton', { name: 'Like' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('togglebutton', { name: 'Save' })).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'More' })).toBeOnTheScreen();
  });

  it('draws Like, Share, Save, More and the way on at 320, 360 and 390 px (the layout itself is checked in the browser)', async () => {
    for (const width of [320, 360, 390]) {
      const view = await dock(width, {
        like: { on: false, onPress: jest.fn() },
        share: { onPress: jest.fn(), what: 'moment' },
        save: { on: false, onPress: jest.fn() },
        onMore: jest.fn(),
        nextPart,
      });
      expect(screen.getAllByRole('button')).toHaveLength(3);
      expect(screen.getAllByRole('togglebutton')).toHaveLength(2);
      expect(screen.getByText('Share', { includeHiddenElements: true })).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Part 2: How tides work' })).toBeOnTheScreen();
      await view.unmount();
    }
  });

  it('is a wrapping row of 44 px targets at large text, so it can grow a line instead of squeezing a control (measured in the browser)', async () => {
    await dock(
      320,
      {
        like: { on: true, onPress: jest.fn() },
        share: { onPress: jest.fn(), what: 'moment' },
        save: { on: false, onPress: jest.fn() },
        onMore: jest.fn(),
        nextPart,
      },
      2,
    );
    expect(screen.getByTestId('reader-dock')).toHaveStyle({ flexWrap: 'wrap' });
    expectPressed(screen.getByRole('togglebutton', { name: 'Like' }), true);
    expectPressed(screen.getByRole('togglebutton', { name: 'Save' }), false);
    expect(screen.getByRole('button', { name: 'Share a moment' })).toHaveStyle({ width: 44, height: 44 });
    expect(screen.getByRole('button', { name: 'More' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Part 2: How tides work' })).toBeOnTheScreen();
  });
});
