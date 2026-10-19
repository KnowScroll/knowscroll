import { fireEvent, screen } from '@testing-library/react-native';
import { content, toggle } from '@knowscroll/design-tokens';
import { expectPressed, renderOn } from '../test-support/render';
import { IconButton } from './icon-button';

describe('IconButton', () => {
  it('is named by its label, never by its icon', async () => {
    const onPress = jest.fn();
    await renderOn(<IconButton icon="back" label="Back to Keep" onPress={onPress} />);

    await fireEvent.press(screen.getByRole('button', { name: 'Back to Keep' }));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('is 48 × 48 by default and 44 × 44 at the compact size; never smaller', async () => {
    await renderOn(
      <>
        <IconButton icon="share" label="Share" />
        <IconButton icon="like" label="Like" size={44} />
      </>,
    );
    expect(screen.getByRole('button', { name: 'Share' })).toHaveStyle({ width: 48, height: 48 });
    expect(screen.getByRole('button', { name: 'Like' })).toHaveStyle({ width: 44, height: 44 });
  });

  it('is a toggle when it has a pressed state; pressed is cobalt on paper, never yellow (D-006 b)', async () => {
    await renderOn(
      <>
        <IconButton icon="like" label="Like" pressed={false} />
        <IconButton icon="save" label="Save" pressed />
      </>,
    );
    expectPressed(screen.getByRole('togglebutton', { name: 'Like' }), false);
    const save = screen.getByRole('togglebutton', { name: 'Save' });
    expectPressed(save, true);
    expect(save).toHaveStyle({ backgroundColor: toggle.pressedOnLight.background });
    expect(save).not.toHaveStyle({ backgroundColor: content.continue });
  });

  it('is filled cream with an ink glyph when pressed over media or the map', async () => {
    await renderOn(<IconButton icon="like" label="Like" variant="onMedia" pressed />);
    expect(screen.getByRole('togglebutton', { name: 'Like' })).toHaveStyle({
      backgroundColor: toggle.pressedOnDark.background,
    });
    expect(toggle.pressedOnDark.foreground).toBe(content.ink);
  });

  it('ignores presses while disabled or busy', async () => {
    const onPress = jest.fn();
    await renderOn(
      <>
        <IconButton icon="send" label="Send" disabled onPress={onPress} />
        <IconButton icon="save" label="Save" busy onPress={onPress} />
      </>,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Send' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeBusy();
    expect(onPress).not.toHaveBeenCalled();
  });
});
