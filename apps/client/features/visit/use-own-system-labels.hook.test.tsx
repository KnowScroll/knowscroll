import { act, renderHook } from '@testing-library/react-native';
import type { AccountScope, UniverseSceneState } from '@knowscroll/client-core';
import { useOwnSystemLabels } from './use-own-system-labels';

const mockSessionFor = jest.fn();
const mockCreateReader = jest.fn();
jest.mock('../universe/use-universe-session', () => ({
  universeSessionFor: (scope: AccountScope) => mockSessionFor(scope) as unknown,
}));
jest.mock('../universe/universe-session', () => ({ sceneCapabilities: () => ({}) }));
jest.mock('@knowscroll/client-core', () => ({
  ...jest.requireActual<object>('@knowscroll/client-core'),
  createUniverseSceneSession: (options: unknown) => mockCreateReader(options) as unknown,
}));

const scope = { id: 'scope-a' } as unknown as AccountScope;
const otherScope = { id: 'scope-b' } as unknown as AccountScope;
const skyOf = (...labels: string[]): UniverseSceneState =>
  ({
    status: 'ready',
    active: true,
    sky: {
      systems: labels.map((label) => ({
        descriptor: { objectId: label, parentId: 'universe', kind: 'system', label, truthStatus: 'factual' },
      })),
    },
  }) as unknown as UniverseSceneState;
const IDLE = { status: 'idle', active: false } as const;

/** An own-Universe session whose read is `read`. */
const sessionOf = (read: UniverseSceneState) => ({
  subscribe: () => () => {},
  getState: () => ({ read }),
});

/** A reader whose answer the test gives when it likes. */
function fakeReader() {
  let state: UniverseSceneState = { status: 'loading', active: true };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: jest.fn(),
    dispose: jest.fn(),
    answer: (next: UniverseSceneState) => {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

beforeEach(() => jest.clearAllMocks());

describe('useOwnSystemLabels', () => {
  it('with the switch off makes no session and no read', async () => {
    const { result } = await renderHook(() => useOwnSystemLabels(scope, false));
    expect(result.current).toBeUndefined();
    expect(mockSessionFor).not.toHaveBeenCalled();
    expect(mockCreateReader).not.toHaveBeenCalled();
  });

  it('takes the names from the session already in memory and reads nothing', async () => {
    mockSessionFor.mockReturnValue(sessionOf(skyOf('Attention', 'Stars')));
    const { result } = await renderHook(() => useOwnSystemLabels(scope, true));
    expect(result.current).toEqual(['Attention', 'Stars']);
    expect(mockCreateReader).not.toHaveBeenCalled();
  });

  it('reads once when that session was never started, and lets the read go when it answers', async () => {
    mockSessionFor.mockReturnValue(sessionOf(IDLE));
    const reader = fakeReader();
    mockCreateReader.mockReturnValue(reader);
    const { result } = await renderHook(() => useOwnSystemLabels(scope, true));
    expect(mockCreateReader).toHaveBeenCalledTimes(1);
    expect(reader.start).toHaveBeenCalledTimes(1);
    expect(result.current).toBeUndefined();
    await act(() => reader.answer(skyOf('Baking')));
    expect(result.current).toEqual(['Baking']);
    expect(reader.dispose).toHaveBeenCalled();
  });

  it('lets the read go when the screen leaves before it answers', async () => {
    mockSessionFor.mockReturnValue(sessionOf(IDLE));
    const reader = fakeReader();
    mockCreateReader.mockReturnValue(reader);
    const { unmount } = await renderHook(() => useOwnSystemLabels(scope, true));
    expect(reader.dispose).not.toHaveBeenCalled();
    await unmount();
    expect(reader.dispose).toHaveBeenCalled();
  });

  it('lets a failed read go, without trying again, and never carries one account’s names to another', async () => {
    mockSessionFor.mockReturnValue(sessionOf(IDLE));
    const reader = fakeReader();
    mockCreateReader.mockReturnValue(reader);
    const { result, rerender } = await renderHook(
      ({ current }: { current: AccountScope }) => useOwnSystemLabels(current, true),
      { initialProps: { current: scope } },
    );
    await act(() => reader.answer(skyOf('Baking')));
    expect(result.current).toEqual(['Baking']);
    const second = fakeReader();
    mockCreateReader.mockReturnValue(second);
    await rerender({ current: otherScope });
    expect(result.current).toBeUndefined();
    await act(() => second.answer({ status: 'unavailable', active: false, reason: 'scope_unavailable' }));
    expect(second.dispose).toHaveBeenCalled();
    expect(result.current).toBeUndefined();
    expect(mockCreateReader).toHaveBeenCalledTimes(2);
  });
});
