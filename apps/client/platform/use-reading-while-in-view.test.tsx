import type { useEffect } from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { useReadingWhileInView } from './use-reading-while-in-view';

let mockFocused = true;
jest.mock('expo-router', () => {
  const { useEffect: useEffectOf } = jest.requireActual<{ useEffect: typeof useEffect }>('react');
  return {
    // Like the navigator: the effect runs while the screen is focused and its cleanup runs when it is covered.
    useFocusEffect: (effect: () => void | (() => void)) =>
      useEffectOf(() => (mockFocused ? effect() : undefined), [effect, mockFocused]),
  };
});

async function setup() {
  const calls: boolean[] = [];
  const controller = {
    setActive: (active: boolean) => void calls.push(active),
    refresh: jest.fn(() => Promise.resolve()),
  };
  const view = await renderHook(() => useReadingWhileInView(controller));
  return { calls, controller, view };
}
const last = (calls: boolean[]) => calls.at(-1);

beforeEach(() => {
  mockFocused = true;
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

describe('a thread or conversation counts as read only while it is in view (#648)', () => {
  it('is active while its screen is focused in the foreground', async () => {
    const { calls } = await setup();
    expect(last(calls)).toBe(true);
  });

  it('is not active while another screen covers it, and is active again when the person returns', async () => {
    const { calls, view } = await setup();
    mockFocused = false;
    await view.rerender({});
    expect(last(calls)).toBe(false);
    mockFocused = true;
    await view.rerender({});
    expect(last(calls)).toBe(true);
  });

  it('is not active while the app is in the background, and reads again on return', async () => {
    let listener: (state: string) => void = () => undefined;
    const add = jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      listener = handler as (state: string) => void;
      return { remove: jest.fn() };
    });
    try {
      const { calls, controller } = await setup();
      await act(() => listener('background'));
      expect(last(calls)).toBe(false);
      await act(() => listener('active'));
      expect(last(calls)).toBe(true);
      expect(controller.refresh).toHaveBeenCalledTimes(1);
    } finally {
      add.mockRestore();
    }
  });
});
