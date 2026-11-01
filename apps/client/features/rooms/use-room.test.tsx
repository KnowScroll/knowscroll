import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { announceBlocksChanged, type AccountScope } from '@knowscroll/client-core';
import { useRoom, useRoomDiscussion } from './use-room';

jest.mock('expo-router', () => ({ useIsFocused: () => true }));
jest.mock('../../platform/command-id', () => {
  let next = 40000;
  return { newCommandId: () => `0199c000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});

const id = (n: number) => `0199c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const asha = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha fixture' };
const room = {
  roomId: id(1),
  name: 'Machine learning room',
  description: 'How computers learn.',
  topic: { kind: 'system' as const, id: 'machine-learning', label: 'Machine learning' },
  joinRule: 'open' as const,
  status: 'open' as const,
};

/** An open discussion's scope: a real query cache, and a server that counts how it is read. */
function openScope() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const reads = { snapshots: 0, changes: 0 };
  const scope = {
    active: true,
    id: 'scope-1',
    queryClient,
    queryKey: (...parts: (string | number)[]) => ['scope', 'scope-1', ...parts],
    api: {
      rooms: {
        readDiscussion: () => {
          reads.snapshots++;
          return Promise.resolve({
            status: 'ready',
            room,
            role: 'member',
            you: asha,
            discussion: { discussionId: id(2), title: 'Topic', pinned: false },
            canPost: true,
            inhabitants: [],
            latestMessageSequence: 0,
            messages: [],
            limit: 30,
            history: { kind: 'end' },
            catchUpCursor: `krc1_${'A'.repeat(26)}`,
          });
        },
        changes: () => {
          reads.changes++;
          return Promise.resolve({
            status: 'ready',
            changes: [],
            continuation: { kind: 'caught_up', cursor: `krc1_${'A'.repeat(26)}` },
          });
        },
      },
    },
  } as unknown as AccountScope;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { scope, reads, wrapper };
}

describe('an open room discussion and the person’s blocks', () => {
  it('takes a fresh snapshot, not only a catch-up, when a block or unblock is accepted while it is open', async () => {
    const { scope, reads, wrapper } = openScope();
    const hook = await renderHook(() => useRoomDiscussion(scope, id(1), id(2)), { wrapper });
    await waitFor(() => expect(hook.result.current.state.phase).toBe('ready'));
    expect(reads.snapshots).toBe(1);

    await act(() => {
      announceBlocksChanged(scope);
    });
    await waitFor(() => {
      expect(reads.snapshots).toBe(2);
    });
    await act(() => {
      announceBlocksChanged(scope);
    });
    await waitFor(() => {
      expect(reads.snapshots).toBe(3);
    });
    await hook.unmount();
  });

  it('does not read afresh for blocks that were announced before it opened', async () => {
    const { scope, reads, wrapper } = openScope();
    announceBlocksChanged(scope);
    const hook = await renderHook(() => useRoomDiscussion(scope, id(1), id(2)), { wrapper });
    await waitFor(() => expect(hook.result.current.state.phase).toBe('ready'));
    expect(reads.snapshots).toBe(1);
    await hook.unmount();
  });
});

describe('an open room and who is here', () => {
  const view = (status: 'member' | 'preview') =>
    status === 'member'
      ? {
          status,
          room,
          role: 'member',
          hasModerator: false,
          inhabitants: [],
          general: {
            discussionId: id(2),
            kind: 'general',
            title: 'General',
            pinned: false,
            lastActivityAt: '2026-10-24T08:00:00.000Z',
            replyCount: 0,
          },
          discussions: [],
          canPost: true,
          you: { aiLevel: 'lively', keepOut: false },
          here: { faces: [{ person: asha, you: true }] },
          memberTotal: 1,
          limits: {
            asked: { perPersonPerHour: 10, perRoomPerDay: 80 },
            unprompted: { humanMessagesPerTurn: 3, perHour: 8, perDay: 40, explainerPerHour: 4, skepticPerHour: 3 },
            feed: { postsPerDay: 3, restHours: 6, memberPostsPerDay: 3 },
          },
        }
      : { status, room, hasModerator: false, inhabitants: [], invited: false, join: { allowed: true } };

  function roomScope(status: 'member' | 'preview') {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const presence: string[] = [];
    const watching = { current: 0 };
    const scope = {
      active: true,
      id: 'scope-1',
      queryClient,
      queryKey: (...parts: (string | number)[]) => ['scope', 'scope-1', ...parts],
      watchRoom: () => {
        watching.current += 1;
        return () => {
          watching.current -= 1;
        };
      },
      api: {
        rooms: {
          read: () => Promise.resolve(view(status)),
          presence: (input: { state: string }) => {
            presence.push(input.state);
            return Promise.resolve({});
          },
        },
      },
    } as unknown as AccountScope;
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { scope, presence, watching, wrapper };
  }

  it('says the room is open and listens for its hints while a member has it open, and says away when they leave', async () => {
    const { scope, presence, watching, wrapper } = roomScope('member');
    const hook = await renderHook(() => useRoom(scope, id(1)), { wrapper });
    await waitFor(() => expect(hook.result.current.state.phase).toBe('member'));
    await waitFor(() => expect(presence).toEqual(['here']));
    expect(watching.current).toBe(1);
    await hook.unmount();
    expect(presence).toEqual(['here', 'away']);
    expect(watching.current).toBe(0);
  });

  it('says nothing about being in a room it is only previewing', async () => {
    const { scope, presence, watching, wrapper } = roomScope('preview');
    const hook = await renderHook(() => useRoom(scope, id(1)), { wrapper });
    await waitFor(() => expect(hook.result.current.state.phase).toBe('preview'));
    await hook.unmount();
    expect(presence).toEqual([]);
    expect(watching.current).toBe(0);
  });
});
