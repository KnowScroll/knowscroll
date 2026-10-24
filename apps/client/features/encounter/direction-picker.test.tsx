import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { offer } from './encounter-session.fixture';
import { DirectionPicker } from './direction-picker';

describe('Somewhere new (E08)', () => {
  it('lists the real offers by title and format, picks one by id, and can be left', async () => {
    const pick = jest.fn();
    const leave = jest.fn();
    const choices = [offer(1), { ...offer(2), metadata: { ...offer(2).metadata, kind: 'scroll' as const } }];
    await render(
      <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
        <DirectionPicker choices={choices} onPick={pick} onLeave={leave} />
      </DisplayProvider>,
    );
    expect(screen.getByRole('header', { name: 'Somewhere new' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Fixture 2. Scroll' }));
    expect(pick).toHaveBeenCalledWith(choices[1]!.offerId);
    expect(screen.getByRole('button', { name: 'Fixture 1. Reel' })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Not now' }));
    expect(leave).toHaveBeenCalledTimes(1);
  });
});
