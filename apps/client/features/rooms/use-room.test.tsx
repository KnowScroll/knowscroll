import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { announceBlocksChanged, type AccountScope } from '@knowscroll/client-core';
import { useRoomDiscussion } from './use-room';

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
