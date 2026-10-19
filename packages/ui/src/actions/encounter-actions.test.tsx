import { fireEvent, screen, within } from '@testing-library/react-native';
import type { Breakpoint } from '@knowscroll/design-tokens';
import { expectPressed, renderOn } from '../test-support/render';
import {
  ActionRail,
  ActionStrip,
  encounterActionPlacement,
  type EncounterAction,
  type EncounterActionsProps,
} from './encounter-actions';

const everything: readonly EncounterAction[] = ['like', 'save', 'share', 'ask', 'more'];

function names(): string[] {
  const toolbar = screen.getByLabelText('Actions');
  expect(toolbar).toHaveProp('role', 'toolbar');
  return within(toolbar)
    .getAllByRole(/^(button|togglebutton)$/)
    .map((element) => String(element.props.accessibilityLabel));
}

describe('encounter actions (D-006 b: one action set, one placement, for Reel and Scroll)', () => {
  const props: EncounterActionsProps = { available: everything, liked: false, saved: true, onAction: () => undefined };

  it.each([
    [320, 1],
    [390, 1],
    [834, 1],
    [1440, 1],
    [390, 2],
  ])(
    'Reel rail and Scroll strip offer the same actions in the same order at %i px, %f× text',
    async (width, textScale) => {
      const reel = await renderOn(<ActionRail {...props} />, { width, textScale });
      const reelNames = names();
      await reel.unmount();
      await renderOn(<ActionStrip {...props} />, { width, textScale });

      expect(names()).toEqual(reelNames);
      expect(reelNames).toEqual(
        textScale > 1.5
          ? ['Like', 'Saved', 'Share', 'Ask', 'More']
          : ['Like', 'Save', 'Share', 'Ask about this', 'More options'],
      );
    },
  );

  it('places actions without knowing the format: always on the end side', () => {
    const displays: { breakpoint: Breakpoint; textScale: number }[] = [
      { breakpoint: 'compact', textScale: 1 },
      { breakpoint: 'phone', textScale: 1 },
      { breakpoint: 'tablet', textScale: 1.3 },
      { breakpoint: 'desktop', textScale: 1 },
      { breakpoint: 'phone', textScale: 2 },
    ];
    for (const display of displays) expect(encounterActionPlacement(display).side).toBe('end');
    expect(encounterActionPlacement({ breakpoint: 'compact', textScale: 1 })).toMatchObject({
      arrangement: 'line',
      compact: true,
    });
    expect(encounterActionPlacement({ breakpoint: 'phone', textScale: 2 })).toMatchObject({ arrangement: 'grid' });
  });

  it('renders only the actions whose commands exist, still in the fixed order', async () => {
    await renderOn(<ActionRail available={['share', 'like']} onAction={() => undefined} />);
    expect(names()).toEqual(['Like', 'Share']);
  });

  it('reports the semantic action, and toggles Like and Save as pressed', async () => {
    const onAction = jest.fn();
    await renderOn(<ActionStrip available={everything} liked saved={false} onAction={onAction} />);

    const like = screen.getByRole('togglebutton', { name: 'Like' });
    const save = screen.getByRole('togglebutton', { name: 'Save' });
    expectPressed(like, true);
    expectPressed(save, false);

    await fireEvent.press(like);
    await fireEvent.press(save);
    await fireEvent.press(screen.getByRole('button', { name: 'Ask about this' }));

    expect(onAction.mock.calls).toEqual([['like'], ['save'], ['ask']]);
  });

  it('shows the Save command in flight as busy and ignores a second press', async () => {
    const onAction = jest.fn();
    await renderOn(<ActionRail available={everything} saving onAction={onAction} />);
    const save = screen.getByRole('togglebutton', { name: 'Save' });

    await fireEvent.press(save);

    expect(save).toBeBusy();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('on compact phones uses 44 px buttons and moves the words into the names (V01)', async () => {
    await renderOn(<ActionRail available={everything} onAction={() => undefined} />, { width: 320 });
    expect(screen.getByRole('button', { name: 'Share' })).toHaveStyle({ width: 44, height: 44 });
    expect(screen.queryByText('Share', { includeHiddenElements: true })).toBeNull();
  });

  it('hides the word under each rail button from screen readers (the button already says it)', async () => {
    await renderOn(<ActionRail available={['share']} onAction={() => undefined} />);
    expect(screen.queryByText('Share')).toBeNull();
    expect(screen.getByText('Share', { includeHiddenElements: true })).toBeTruthy();
  });
});
