import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { KEYBOARD_MAP, KeyboardMapSheet } from './keyboard-map';

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

  it('closes from its own Close control', async () => {
    const onClose = await show();
    await fireEvent.press(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
