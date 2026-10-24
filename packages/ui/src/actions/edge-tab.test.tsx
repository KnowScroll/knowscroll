import { fireEvent, screen } from '@testing-library/react-native';
import { content, focusRing } from '@knowscroll/design-tokens';
import { renderOn } from '../test-support/render';
import { EdgeTab } from './edge-tab';

describe('EdgeTab', () => {
  it('names the destination, not the arrow, and presses through', async () => {
    const onPress = jest.fn();
    await renderOn(
      <EdgeTab kind="part" label="Part 2" accessibilityLabel="Continue: Part 2, Attention at work" onPress={onPress} />,
    );
    const tab = screen.getByRole('button', { name: 'Continue: Part 2, Attention at work' });
    expect(screen.getByText('Part 2')).toBeOnTheScreen();

    await fireEvent.press(tab);

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('draws a Part solid yellow, Related dashed on paper and the previous step in ink', async () => {
    const view = await renderOn(
      <EdgeTab kind="part" label="Part 2" accessibilityLabel="Part" onPress={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Part' })).toHaveStyle({
      backgroundColor: content.continue,
      borderStyle: 'solid',
    });
    await view.rerender(
      <EdgeTab kind="related" label="Related" accessibilityLabel="Related" onPress={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Related' })).toHaveStyle({
      backgroundColor: content.paper,
      borderStyle: 'dashed',
    });
    await view.rerender(
      <EdgeTab kind="previous" label="Part 1" accessibilityLabel="Previous" onPress={() => undefined} />,
    );
    expect(screen.getByRole('button', { name: 'Previous' })).toHaveStyle({ backgroundColor: content.nav });
  });

  it('is at least 44 px and shows the focus ring on dark', async () => {
    await renderOn(<EdgeTab kind="part" label="Part 2" accessibilityLabel="Next" onPress={() => undefined} />);
    const tab = screen.getByRole('button', { name: 'Next' });
    expect(tab).toHaveStyle({ minHeight: 72, minWidth: 64 });
    await fireEvent(tab, 'focus');
    expect(tab).toHaveStyle({ outlineColor: focusRing.onDark.color });
  });

  it('ignores presses while disabled', async () => {
    const onPress = jest.fn();
    await renderOn(<EdgeTab kind="part" label="Part 2" accessibilityLabel="Next" onPress={onPress} disabled />);

    await fireEvent.press(screen.getByRole('button', { name: 'Next' }));

    expect(onPress).not.toHaveBeenCalled();
  });
});
