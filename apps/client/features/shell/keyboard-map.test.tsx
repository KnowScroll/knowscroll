import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider, FOLIO_KEY_NAMES } from '@knowscroll/ui';
import { KEYBOARD_MAP, KeyboardMapSheet } from './keyboard-map';
import { UNIVERSE_MAP_KEY_NAMES } from '../universe/universe-stage';
import { MadeToOrderContext, type MadeToOrderState } from '../../providers/made-to-order';

async function show(onClose = jest.fn()) {
  await render(
    <DisplayProvider value={{ width: 1440, textScale: 1, reducedMotion: true }}>
      <KeyboardMapSheet visible onClose={onClose} />
    </DisplayProvider>,
  );
  return onClose;
}

describe('the keyboard map', () => {
  it('names every group and says where its keys work', async () => {
    await show();
    for (const group of KEYBOARD_MAP) {
      expect(screen.getByText(group.title)).toBeOnTheScreen();
      expect(screen.getByText(group.where)).toBeOnTheScreen();
    }
  });

  it('gives each key a spoken name that says what it does', async () => {
    await show();
    expect(screen.getByLabelText('Up and down arrow: Previous and next subject')).toBeOnTheScreen();
    expect(screen.getByLabelText('Space: Play or pause')).toBeOnTheScreen();
    expect(screen.getByLabelText('Slash: Search places')).toBeOnTheScreen();
  });

  it('says what right and left arrow mean: along a Reel’s thread the way on may be another angle, in a Scroll it is a Part', async () => {
    await show();
    expect(
      screen.getByLabelText(
        'Left and right arrow: Along the thread: the part before, and the next part or another angle when there is none',
      ),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('Right arrow: The next Part')).toBeOnTheScreen();
    expect(screen.getByLabelText('Left arrow: Back to the Part before')).toBeOnTheScreen();
  });

  it('lists every key the Scroll reader listens to, so a new key cannot go unlisted', () => {
    const group = KEYBOARD_MAP.find((entry) => entry.title === 'Scroll reader');
    const listed = new Set(group?.shortcuts.flatMap((shortcut) => shortcut.keys));
    const drawn: Record<string, string> = {
      ArrowDown: '↓',
      ArrowUp: '↑',
      ArrowRight: '→',
      ArrowLeft: '←',
      ' ': 'Space',
      PageDown: 'PgDn',
      PageUp: 'PgUp',
      Home: 'Home',
      End: 'End',
      'Shift+S': '⇧S',
    };
    for (const name of FOLIO_KEY_NAMES) expect(listed).toContain(drawn[name] ?? name.toUpperCase());
  });

  it('lists every key the Universe map listens to, and Escape, so a new key cannot go unlisted', () => {
    const group = KEYBOARD_MAP.find((entry) => entry.title === 'Universe');
    const listed = new Set(group?.shortcuts.flatMap((shortcut) => shortcut.keys));
    const drawn: Record<string, string> = {
      ArrowLeft: '←',
      ArrowRight: '→',
      ArrowUp: '↑',
      ArrowDown: '↓',
      '=': '+',
      '-': '−',
    };
    for (const name of UNIVERSE_MAP_KEY_NAMES) expect(listed).toContain(drawn[name] ?? name);
    expect(listed).toContain('Esc');
  });

  it('closes from its own Close control', async () => {
    const onClose = await show();
    await fireEvent.press(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the keyboard map and the made-to-order switch (D-436)', () => {
  const showWith = async (state: MadeToOrderState) => {
    await render(
      <DisplayProvider value={{ width: 1440, textScale: 1, reducedMotion: true }}>
        <MadeToOrderContext.Provider value={state}>
          <KeyboardMapSheet visible onClose={jest.fn()} />
        </MadeToOrderContext.Provider>
      </DisplayProvider>,
    );
  };

  it('lists the Ask keys while the switch is on', async () => {
    await showWith('on');
    expect(
      screen.getByLabelText('A or question mark: Ask about this (while reading a Scroll; also the first row of •••)'),
    ).toBeOnTheScreen();
    expect(screen.getByLabelText('1, 2 or 3: In the Ask sheet: pick a suggested question')).toBeOnTheScreen();
  });

  for (const state of ['off', 'unknown'] as const)
    it(`does not promise the Ask keys while the switch is ${state}, and keeps the other Scroll keys`, async () => {
      await showWith(state);
      expect(screen.queryByLabelText(/Ask about this/)).toBeNull();
      expect(screen.queryByLabelText(/In the Ask sheet/)).toBeNull();
      expect(screen.getByLabelText('T: Text version: every figure as words')).toBeOnTheScreen();
    });
});
