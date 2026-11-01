import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import type { AccountScope } from '@knowscroll/client-core';
import { useRoom } from './use-room';

// Beats every 40 ms instead of every 25 s, so a real clock can show whether they go on or stop.
jest.mock('@knowscroll/contracts', () => ({
  ...jest.requireActual<object>('@knowscroll/contracts'),
  ROOM_PRESENCE_BEAT_MS: 40,
}));
let mockFocused = true;
jest.mock('expo-router', () => ({ useIsFocused: () => mockFocused }));
jest.mock('../../platform/command-id', () => {
  let next = 50000;
  return { newCommandId: () => `0199c000-0000-7000-8000-${(next++).toString(16).padStart(12, '0')}` };
});

const id = (n: number) => `0199c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const room = {
  roomId: id(1),
  name: 'Machine learning room',
  description: 'How computers learn.',
  topic: { kind: 'system' as const, id: 'machine-learning', label: 'Machine learning' },
  joinRule: 'open' as const,
  status: 'open' as const,
};
const asha = { kind: 'person' as const, personId: id(10), handle: 'ci.asha', displayName: 'Asha fixture' };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function memberScope() {
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
        read: () =>
          Promise.resolve({
            status: 'member',
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
          }),
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

describe('a room that another screen covers', () => {
  it('says the room is closed and stops beating when it loses focus, and starts again when it is back', async () => {
    mockFocused = true;
    const { scope, presence, watching, wrapper } = memberScope();
    const hook = await renderHook(() => useRoom(scope, id(1)), { wrapper });
    await waitFor(() => expect(presence.filter((state) => state === 'here').length).toBeGreaterThanOrEqual(2));
    expect(watching.current).toBe(1);

    // A Reel opened from the room covers it: the route stays mounted but is no longer on screen.
    mockFocused = false;
    await act(async () => {
      await hook.rerender({});
    });
    await waitFor(() => expect(presence.at(-1)).toBe('away'));
    expect(watching.current).toBe(0);
    const settled = presence.length;
    await act(async () => {
      await sleep(250);
    });
    expect(presence).toHaveLength(settled);

    mockFocused = true;
    await act(async () => {
      await hook.rerender({});
    });
    await waitFor(() => expect(presence.length).toBeGreaterThan(settled));
    expect(presence.at(settled)).toBe('here');
    expect(watching.current).toBe(1);
    await hook.unmount();
    expect(presence.at(-1)).toBe('away');
  });
});
