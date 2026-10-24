import { fireEvent, render, screen } from '@testing-library/react-native';
import type { FeedbackState, FeedbackStore, NotInterestedState } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { NotInterestedNotice } from './not-interested-notice';

// The acknowledgement of "Not interested" over a stand-in store: each state says what happened in plain
// words, offers Undo only while it can be taken back, and a failure keeps its Retry.
const assetId = '0199a000-0000-7000-8000-000000000001';

async function show(notInterested: NotInterestedState) {
  const state: FeedbackState = { notInterested, queued: 0 };
  const store = { subscribe: () => () => undefined, getState: () => state } as unknown as FeedbackStore;
  const onUndo = jest.fn();
  const onRetry = jest.fn();
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <NotInterestedNotice store={store} onUndo={onUndo} onRetry={onRetry} />
    </DisplayProvider>,
  );
  return { onUndo, onRetry };
}

describe('the Not interested notice', () => {
  it('shows nothing when nothing was marked', async () => {
    await show({ status: 'idle' });
    expect(screen.queryByTestId('not-interested-notice')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('acknowledges plainly, asks for no reason, and offers Undo', async () => {
    const { onUndo } = await show({ status: 'acknowledged', assetId, resume: 'exposure-1' });
    expect(screen.getByText('Got it — we won’t show this for a while.')).toBeOnTheScreen();
    // Announced politely, without moving focus.
    expect(screen.getByTestId('not-interested-notice').props.role).toBe('status');
    await fireEvent.press(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('says it is saving or taking it back, with no button to press meanwhile', async () => {
    await show({ status: 'saving', assetId });
    expect(screen.getByLabelText('Saving. One moment.')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
    await screen.unmount();
    await show({ status: 'undoing', assetId });
    expect(screen.getByLabelText('Taking that back. One moment.')).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says a save failed, that nothing changed, and keeps a Retry', async () => {
    const { onRetry, onUndo } = await show({ status: 'failed', assetId, step: 'mark' });
    expect(screen.getByLabelText('Couldn’t save that. It hasn’t changed what you’re offered.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onUndo).not.toHaveBeenCalled();
  });

  it('says an Undo failed and that it is still saved, with a Retry', async () => {
    const { onRetry } = await show({ status: 'failed', assetId, step: 'undo' });
    expect(screen.getByLabelText('Couldn’t undo that. It is still saved.')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
