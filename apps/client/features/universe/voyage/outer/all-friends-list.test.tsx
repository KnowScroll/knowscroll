import { fireEvent, render, screen } from '@testing-library/react-native';
import { AllFriendsChip, AllFriendsList, AllFriendsSheet } from './all-friends-list';
import type { OuterFriend } from './friend-order';

const friends = (count: number): readonly OuterFriend[] =>
  Array.from({ length: count }, (_, index) => ({
    personId: `id-${index}`,
    handle: `friend${index}`,
    name: `Friend ${index}`,
  }));

describe('the list of all friends', () => {
  it('has a chip that says how many, and opens on a press', async () => {
    const onPress = jest.fn();
    await render(<AllFriendsChip count={14} onPress={onPress} />);
    await fireEvent.press(screen.getByRole('button', { name: 'All friends (14)' }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('says a count only for a finished read that has every friend, on the chip, the sheet and the list', async () => {
    await render(<AllFriendsChip count={50} status="failed" complete={false} onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'All friends' })).toBeTruthy();
    await screen.unmount();
    await render(<AllFriendsChip count={50} complete={false} onPress={() => {}} />);
    expect(screen.getByRole('button', { name: 'All friends' })).toBeTruthy();
    await screen.unmount();
    await render(
      <AllFriendsSheet
        visible
        friends={friends(3)}
        status="failed"
        complete={false}
        onClose={() => {}}
        onCross={() => {}}
      />,
    );
    expect(screen.getByText('All friends')).toBeTruthy();
    expect(screen.queryByText(/All friends \(/)).toBeNull();
  });

  it('lists every friend, one row each, and nothing else: the unnamed universes are not in it', async () => {
    await render(<AllFriendsList friends={friends(40)} onChoose={() => {}} />);
    expect(screen.getAllByRole('button')).toHaveLength(40);
    expect(screen.getByRole('button', { name: 'Friend 39’s universe, @friend39' })).toBeTruthy();
  });

  it('calls onChoose with the handle of the row pressed', async () => {
    const onChoose = jest.fn();
    await render(<AllFriendsList friends={friends(3)} onChoose={onChoose} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Friend 1’s universe, @friend1' }));
    expect(onChoose).toHaveBeenCalledWith('friend1');
  });

  it('is honest about a read that is not all of them, and about one that failed', async () => {
    const onRetry = jest.fn();
    await render(<AllFriendsList friends={friends(3)} complete={false} onChoose={() => {}} />);
    expect(screen.getByText('Showing the first 3 friends.')).toBeTruthy();
    await screen.unmount();
    await render(
      <AllFriendsList friends={friends(2)} status="failed" complete={false} onChoose={() => {}} onRetry={onRetry} />,
    );
    await fireEvent.press(screen.getByTestId('outer-list-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Showing the first/)).toBeNull();
  });

  it('says so when there are no friends, and never invents any', async () => {
    await render(<AllFriendsList friends={[]} onChoose={() => {}} />);
    expect(screen.getByText(/haven’t got any friends/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('in a sheet titled with the count, closes and then crosses', async () => {
    jest.useFakeTimers();
    const onClose = jest.fn();
    const onCross = jest.fn();
    await render(<AllFriendsSheet visible friends={friends(3)} onClose={onClose} onCross={onCross} />);
    expect(screen.getByText('All friends (3)')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Friend 2’s universe, @friend2' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await jest.runAllTimersAsync();
    expect(onCross).toHaveBeenCalledWith('friend2');
    jest.useRealTimers();
  });
});
