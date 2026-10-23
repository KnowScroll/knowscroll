import { fireEvent, screen } from '@testing-library/react-native';
import { renderOn } from '../test-support/render';
import { expectPressed } from '../test-support/render';
import { ReelProgress, formatClock } from './reel-progress';

describe('formatClock', () => {
  it('writes whole seconds as m:ss and never goes negative or non-finite', () => {
    expect(formatClock(31_000)).toBe('0:31');
    expect(formatClock(31_999)).toBe('0:31');
    expect(formatClock(60_000)).toBe('1:00');
    expect(formatClock(-5)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('ReelProgress', () => {
  it('reads out the position as a progress bar without percentages', async () => {
    await renderOn(<ReelProgress positionMs={31_000} durationMs={50_000} muted={false} />);
    const bar = screen.getByLabelText('Reel progress');
    expect(bar).toHaveProp('aria-valuetext', '0:31 of 0:50');
    expect(screen.getByText('0:31 / 0:50')).toBeOnTheScreen();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers an explicit sound switch that says what it does', async () => {
    const toggle = jest.fn();
    const view = await renderOn(
      <ReelProgress positionMs={0} durationMs={20_000} muted={false} onToggleMuted={toggle} />,
    );
    expectPressed(screen.getByRole('togglebutton', { name: 'Mute' }), false);

    await fireEvent.press(screen.getByRole('togglebutton', { name: 'Mute' }));
    expect(toggle).toHaveBeenCalledTimes(1);

    await view.rerender(<ReelProgress positionMs={0} durationMs={20_000} muted onToggleMuted={toggle} />);
    expectPressed(screen.getByRole('togglebutton', { name: 'Unmute' }), true);
  });
});
