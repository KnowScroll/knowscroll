import { fireEvent, render, screen } from '@testing-library/react-native';
import { space } from '@knowscroll/design-tokens';
import { DisplayProvider } from '@knowscroll/ui';
import { ActivityHeader } from './activity-header';

describe('the activity header (R03)', () => {
  it('is the room’s dark band with the activity’s name and a Back that leaves with no ceremony', async () => {
    const back = jest.fn();
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <ActivityHeader title="Room poll" onBack={back} />
      </DisplayProvider>,
    );
    expect(screen.getByText('Room poll')).toBeOnTheScreen();
    expect(screen.getByTestId('activity-header')).toHaveStyle({ backgroundColor: space.s0 });
    await fireEvent.press(screen.getByRole('button', { name: 'Back' }));
    expect(back).toHaveBeenCalledTimes(1);
  });
});
