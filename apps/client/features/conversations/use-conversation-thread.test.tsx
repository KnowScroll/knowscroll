import type * as React from 'react';
import { renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { useConversationThread } from './use-conversation-thread';
import { useContentThread } from '../threads/use-content-thread';

/**
 * A thread or conversation screen kept under another (a Scroll opened from it) must not count what arrives meanwhile as
 * read: the stored position can be shown to the other person as "seen". Over the real hooks, with the controllers
 * replaced by recorders of what they are told (their own rules are tested in client-core).
 */
const mockActive: boolean[] = [];
const mockState = {};
const mockController = {
  getState: () => mockState,
  subscribe: () => () => undefined,
  refresh: () => Promise.resolve(),
  setActive: (active: boolean) => void mockActive.push(active),
};
jest.mock('@knowscroll/client-core', () => ({
  TALK_QUERY_KEY: 'talk',
  createConversationThread: () => mockController,
  createContentThread: () => mockController,
}));
jest.mock('@tanstack/react-query', () => ({ useQuery: () => ({}) }));
let mockFocused = true;
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: () => void | (() => void)) =>
      // eslint-disable-next-line react-hooks/exhaustive-deps -- the test flips `mockFocused` between renders, as a navigator flips focus.
      useEffect(() => (mockFocused ? effect() : undefined), [effect, mockFocused]),
  };
});
jest.mock('../../platform/command-id', () => ({ newCommandId: () => 'command' }));

const scope = { queryKey: (...parts: string[]) => parts } as unknown as AccountScope;
const conversation = { conversationId: 'c', membershipId: 'm', revision: 1 } as never;
const thread = { threadId: 't' } as never;

beforeEach(() => {
  mockActive.length = 0;
  mockFocused = true;
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

const hooks: [string, () => unknown][] = [
  ['conversation', () => useConversationThread(scope, conversation)],
  ['thread', () => useContentThread(scope, thread)],
];
describe.each(hooks)('the %s hook', (_name, hook) => {
  it('counts messages as read only while its screen is the one in view', async () => {
    const view = await renderHook(hook);
    expect(mockActive.at(-1)).toBe(true);
    mockFocused = false;
    await view.rerender({});
    expect(mockActive.at(-1)).toBe(false);
    mockFocused = true;
    await view.rerender({});
    expect(mockActive.at(-1)).toBe(true);
  });
});
