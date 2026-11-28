import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { AccountScope, FriendsState } from '@knowscroll/client-core';
import type { FriendsPager } from './read-friends';
import { FRIENDS_KEPT_AFTER_LEAVING_MS, useOuterFriends } from './use-outer-friends';

const scopeOf = (active = true): AccountScope => ({ active, onEnd: () => () => {} }) as unknown as AccountScope;

function fakeSession(handles: readonly string[], gate?: Promise<void>): FriendsPager & { dispose: jest.Mock } {
  const state = {
    status: 'active',
    roster: {
      status: 'ready',
      data: {
        items: handles.map((handle) => ({
          state: 'friends',
          peer: { kind: 'person', personId: `id-${handle}`, handle, displayName: handle.toUpperCase() },
          pairRevision: 1,
          availability: { state: 'online' },
        })),
      },
    },
  } as unknown as FriendsState;
  return { getState: () => state, selectFilter: async () => gate, nextPage: async () => {}, dispose: jest.fn() };
}

describe('the outer stop’s read of the friends', () => {
  it('reads nothing until it is active, and nothing without an account', async () => {
    const make = jest.fn(() => fakeSession(['a']));
    // The reader's session maker is a dependency of its effect: tests hand in one function for the whole test.
    const idle = await renderHook(() => useOuterFriends(scopeOf(), false, make));
    expect(idle.result.current.status).toBe('idle');
    const none = await renderHook(() => useOuterFriends(undefined, true, make));
    expect(none.result.current.status).toBe('idle');
    expect(make).not.toHaveBeenCalled();
  });

  it('is loading, then ready with the friends in the roster’s order, and says the list is complete', async () => {
    let open: () => void = () => {};
    const session = fakeSession(['ravi', 'mei'], new Promise<void>((resolve) => (open = resolve)));
    const make = () => session;
    const scope = scopeOf();
    const { result } = await renderHook(() => useOuterFriends(scope, true, make));
    expect(result.current.status).toBe('loading');
    expect(result.current.friends).toEqual([]);
    await act(() => {
      open();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.friends.map((friend) => friend.handle)).toEqual(['ravi', 'mei']);
    expect(result.current.complete).toBe(true);
  });

  it('stops the read when it turns inactive, keeps the friends while they fade out, then forgets them; reads again when active', async () => {
    const sessions: ReturnType<typeof fakeSession>[] = [];
    const make = () => {
      const made = fakeSession(['a']);
      sessions.push(made);
      return made;
    };
    const scope = scopeOf();
    const { result, rerender } = await renderHook(
      ({ active }: { active: boolean }) => useOuterFriends(scope, active, make),
      {
        initialProps: { active: true },
      },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    await rerender({ active: false });
    expect(sessions[0]!.dispose).toHaveBeenCalledTimes(1);
    // Kept while the flight back in fades them out.
    expect(result.current.friends.map((friend) => friend.handle)).toEqual(['a']);
    await act(() => new Promise((resolve) => setTimeout(resolve, FRIENDS_KEPT_AFTER_LEAVING_MS + 50)));
    expect(result.current.status).toBe('idle');
    expect(result.current.friends).toEqual([]);
    await rerender({ active: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(sessions).toHaveLength(2);
  });

  it('reports a failed read, and reads again on retry', async () => {
    let fail = true;
    const make = () => {
      const made = fakeSession(['a']);
      if (fail)
        (made as { getState: () => FriendsState }).getState = () =>
          ({ status: 'active', roster: { status: 'unavailable', reason: 'network' } }) as unknown as FriendsState;
      return made;
    };
    const scope = scopeOf();
    const { result } = await renderHook(() => useOuterFriends(scope, true, make));
    await waitFor(() => expect(result.current.status).toBe('offline'));
    fail = false;
    await act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });
});
