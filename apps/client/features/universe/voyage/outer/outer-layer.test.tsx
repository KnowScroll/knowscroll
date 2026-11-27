import { fireEvent, render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { OuterLayer, type OuterLayerProps } from './outer-layer';
import { layoutField, panLimit } from './friend-field';
import type { OuterFriend } from './friend-order';

const friends = (count: number): readonly OuterFriend[] =>
  Array.from({ length: count }, (_, index) => ({
    personId: `id-${index}`,
    handle: `friend${index}`,
    name: `Friend ${index}`,
  }));

const base = (over: Partial<OuterLayerProps> = {}): OuterLayerProps => ({
  universe: { x: 218, y: 410, radiusPx: 51, fade: 1 },
  pan: { x: 0, y: 0 },
  friends: friends(14),
  viewport: { width: 390, height: 844 },
  buttonsLive: true,
  reducedMotion: false,
  onCross: () => {},
  ...over,
});
const REST = { viewport: { width: 390, height: 844 }, universe: { x: 218, y: 410, radiusPx: 51 }, pan: { x: 0, y: 0 } };
const styleOf = (node: { props: { style?: Parameters<typeof StyleSheet.flatten>[0] } }): Record<string, number> =>
  StyleSheet.flatten(node.props.style) as unknown as Record<string, number>;
/** The drawing is hidden from assistive technology, so a query must say it may look at hidden things too. */
const hidden = { includeHiddenElements: true } as const;

describe('the outer layer', () => {
  it('draws nothing without a universe, or when it is faded right out', async () => {
    await render(<OuterLayer {...base({ universe: null })} />);
    expect(screen.queryByTestId('outer-layer', hidden)).toBeNull();
    await screen.unmount();
    await render(<OuterLayer {...base({ universe: { x: 218, y: 410, radiusPx: 51, fade: 0 } })} />);
    expect(screen.queryByTestId('outer-layer', hidden)).toBeNull();
  });

  it('eases the whole layer with `fade`, and under reduced motion shows it whole at once', async () => {
    await render(<OuterLayer {...base({ universe: { x: 218, y: 410, radiusPx: 51, fade: 0.4 } })} />);
    expect(styleOf(screen.getByTestId('outer-layer', hidden)).opacity).toBeCloseTo(0.4);
    await screen.unmount();
    await render(
      <OuterLayer {...base({ universe: { x: 218, y: 410, radiusPx: 51, fade: 0.4 }, reducedMotion: true })} />,
    );
    expect(styleOf(screen.getByTestId('outer-layer', hidden)).opacity).toBe(1);
  });

  it('mounts the friend buttons only while buttons are live, one 48 px button for each friend on screen', async () => {
    const shown = layoutField(friends(14), REST).friends;
    await render(<OuterLayer {...base({ buttonsLive: false })} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    await screen.unmount();
    await render(<OuterLayer {...base()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(shown.length);
    expect(buttons.length).toBeLessThanOrEqual(10);
    for (const button of buttons) {
      const style = styleOf(button);
      expect(style.width).toBeGreaterThanOrEqual(48);
      expect(style.height).toBeGreaterThanOrEqual(48);
    }
  });

  it('names each button “<name>’s universe” and crosses to that friend’s handle on a press', async () => {
    const onCross = jest.fn();
    const shown = layoutField(friends(14), REST).friends;
    await render(<OuterLayer {...base({ onCross })} />);
    const first = shown[0]!;
    await fireEvent.press(screen.getByRole('button', { name: `${first.name}’s universe` }));
    expect(onCross).toHaveBeenCalledWith(first.handle);
    expect(onCross).toHaveBeenCalledTimes(1);
  });

  it('draws the seven unnamed universes as decoration only: no button, no name, hidden from assistive technology', async () => {
    await render(<OuterLayer {...base({ friends: [] })} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    const drawing = screen.getByTestId('outer-drawing', hidden);
    expect(drawing.props['aria-hidden']).toBe(true);
    expect(drawing.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(drawing.props.pointerEvents).toBe('none');
    // Nothing the screen reader can reach but the title and the line.
    expect(screen.queryByText('Beyond your universe')).not.toBeNull();
    expect(screen.queryByText('No friends here yet')).not.toBeNull();
    expect(screen.queryByText('Your universe')).toBeNull();
  });

  it('says the title and the count of friends only, never counting the unnamed seven', async () => {
    await render(<OuterLayer {...base({ friends: friends(14) })} />);
    expect(screen.getByText('Beyond your universe')).toBeTruthy();
    expect(screen.getByTestId('outer-line').props.children).toBe('14 friends');
    await screen.unmount();
    await render(<OuterLayer {...base({ friends: friends(1) })} />);
    expect(screen.getByTestId('outer-line').props.children).toBe('1 friend');
  });

  it('never says a count while the friends are still being read, and offers a retry after a failure', async () => {
    const onRetry = jest.fn();
    await render(<OuterLayer {...base({ friends: [], status: 'loading' })} />);
    expect(screen.getByTestId('outer-line').props.children).toBe('Looking for your friends');
    await screen.unmount();
    await render(<OuterLayer {...base({ friends: [], status: 'offline', onRetry })} />);
    await fireEvent.press(screen.getByTestId('outer-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('moves the friends with the pan: other buttons appear when the field is panned', async () => {
    const list = friends(40);
    await render(<OuterLayer {...base({ friends: list })} />);
    const rest = screen.getAllByRole('button').map((button) => String(button.props.accessibilityLabel));
    await screen.unmount();
    const limit = panLimit(40, 64);
    await render(<OuterLayer {...base({ friends: list, pan: { x: -limit * 0.8, y: limit * 0.4 } })} />);
    const panned = screen.getAllByRole('button').map((button) => String(button.props.accessibilityLabel));
    expect(panned.some((label) => !rest.includes(label))).toBe(true);
    expect(panned.length).toBeLessThanOrEqual(10);
  });

  it('draws “Your universe” under your own bubble and each friend’s name, not their handle', async () => {
    await render(<OuterLayer {...base({ friends: friends(2) })} />);
    expect(screen.getByText('Your universe', hidden)).toBeTruthy();
    expect(screen.queryByText(/^Friend 0/, hidden)).not.toBeNull();
    expect(screen.queryByText(/friend0/, hidden)).toBeNull();
  });

  it('leaves the title and its line to the screen’s header when told not to draw them', async () => {
    await render(<OuterLayer {...base({ words: false })} />);
    expect(screen.queryByText('Beyond your universe')).toBeNull();
    expect(screen.queryByTestId('outer-line')).toBeNull();
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0);
  });

  it('tells where its bubbles are, so a parked ship keeps off them, and that they are gone when it goes', async () => {
    const told = jest.fn((_discs: readonly { x: number; y: number; r: number }[]) => undefined);
    await render(<OuterLayer {...base({ friends: friends(3), onBubbles: told })} />);
    const discs = told.mock.calls.at(-1)![0];
    // Yours, the friends', and the unnamed ones in view.
    expect(discs.length).toBeGreaterThanOrEqual(4);
    expect(discs.some((disc) => Math.abs(disc.x - 218) < 1 && Math.abs(disc.y - 410) < 1)).toBe(true);
    await screen.unmount();
    expect(told.mock.calls.at(-1)).toEqual([[]]);
  });
});
