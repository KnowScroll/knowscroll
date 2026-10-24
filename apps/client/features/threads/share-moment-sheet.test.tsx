import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { ShareMomentSheet } from './share-moment-sheet';

async function show(props: Partial<Parameters<typeof ShareMomentSheet>[0]> = {}) {
  const onShare = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ShareMomentSheet
        visible
        title="The edge"
        durationMs={30_000}
        positionMs={18_700}
        currentPositionMs={() => 22_400}
        threadName="Black holes"
        onShare={onShare}
        onClose={jest.fn()}
        {...props}
      />
    </DisplayProvider>,
  );
  return onShare;
}

describe('sharing a moment', () => {
  it('starts where the player is, on a whole second, ten seconds long', async () => {
    await show();
    expect(screen.getByText('0:18–0:28')).toBeOnTheScreen();
    expect(screen.getByText('To · Black holes')).toBeOnTheScreen();
  });

  it('moves either end a step at a time, or to where the player is now, and shares that range', async () => {
    const onShare = await show();
    const start = screen.getByLabelText('Start 0:18');
    await fireEvent.press(within(start).getByRole('button', { name: '+1 s' }));
    const end = screen.getByLabelText('End 0:28');
    await fireEvent.press(within(end).getByRole('button', { name: 'Here' }));
    expect(screen.getByText('0:19–0:22')).toBeOnTheScreen();
    await fireEvent.changeText(screen.getByLabelText('Message'), '  Does this hold?  ');
    await fireEvent.press(screen.getByRole('button', { name: 'Share' }));
    expect(onShare).toHaveBeenCalledWith({ startMs: 19_000, endMs: 22_000 }, 'Does this hold?');
  });

  it('never lets the range leave the Reel or shrink below a second', async () => {
    await show({ positionMs: 29_500 });
    expect(screen.getByText('0:29–0:30')).toBeOnTheScreen();
    const end = screen.getByLabelText('End 0:30');
    await fireEvent.press(within(end).getByRole('button', { name: '+5 s' }));
    await fireEvent.press(within(end).getByRole('button', { name: '−5 s' }));
    expect(screen.getByText('0:29–0:30')).toBeOnTheScreen();
  });
});
