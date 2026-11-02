import { render, screen } from '@testing-library/react-native';
import type { ShareState } from '@knowscroll/client-core';
import { DisplayProvider } from '@knowscroll/ui';
import { FriendPicker } from './friend-picker';

function show(targets: ShareState['targets']) {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <FriendPicker
        targets={targets}
        selected={undefined}
        locked={false}
        onSelect={jest.fn()}
        availabilityOf={() => undefined}
      />
    </DisplayProvider>,
  );
}

describe('the friend list of a sheet', () => {
  it('loads as a skeleton row, not a line of text', async () => {
    await show({ status: 'loading', items: [] });
    expect(screen.getByRole('progressbar', { name: 'Loading your friends' })).toBeOnTheScreen();
    expect(screen.queryByText('Loading your friends…')).not.toBeOnTheScreen();
  });

  it('says so plainly when it failed or there is nobody to send to', async () => {
    const failed = await show({ status: 'failed', items: [] });
    expect(screen.getByText('Couldn’t load your friends.')).toBeOnTheScreen();
    expect(screen.queryByRole('progressbar')).not.toBeOnTheScreen();
    await failed.unmount();
    await show({ status: 'ready', items: [] });
    expect(screen.getByText(/You haven’t got any friends here yet/)).toBeOnTheScreen();
  });
});
