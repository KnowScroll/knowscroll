import type * as React from 'react';
import type * as OuterStopModule from './voyage/outer/outer-stop';
import { type EffectCallback } from 'react';
import { act, render } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { DisplayProvider } from '@knowscroll/ui';
import type { AccountScope } from '@knowscroll/client-core';
import { SignedInUniverse } from './universe-screen';
import type { OuterStop } from './voyage/outer/outer-stop';

/**
 * What the Universe screen does for the outer stop (#811): makes its flag once, gives it to the tree only with the trial
 * on, folds it into Back (list, then stop, then the session), and drops it when the screen blurs or anything moves to a
 * place. The screen's session and surface are stand-ins here: the browser spec draws the real thing.
 */
let mockTrialOn = true;
jest.mock('./universe-trial', () => ({ useUniverseTrial: () => ({ on: mockTrialOn, frameRate: false }) }));

const mockSeen: {
  store: OuterStop | null;
  surface: Record<string, unknown>;
  back: Record<string, (...args: never[]) => unknown> | null;
  focus: EffectCallback | null;
} = { store: null, surface: {}, back: null, focus: null };

jest.mock('./universe-surface', () => ({
  UniverseSurface: (props: Record<string, unknown>) => {
    mockSeen.store = jest.requireActual<typeof OuterStopModule>('./voyage/outer/outer-stop').useOuterStop();
    mockSeen.surface = props;
    return null;
  },
}));
jest.mock('./use-universe-back', () => ({
  useUniverseBack: (session: NonNullable<typeof mockSeen.back>) => {
    mockSeen.back = session;
    return session['back'];
  },
}));
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: EffectCallback) => {
    mockSeen.focus = effect;
  },
  useRouter: () => ({ navigate: jest.fn(), push: mockPush }),
  useLocalSearchParams: () => ({}),
}));
const mockPush = jest.fn();
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
jest.mock('../rooms/use-room-stations', () => ({ useRoomStationsOnMap: () => [] }));
jest.mock('../../platform/document-title', () => ({ useDocumentTitle: () => undefined }));
jest.mock('./formation-presentation', () => ({ FormationNotice: () => null, FormationPresentation: () => null }));
jest.mock('./universe-places', () => ({ descriptorsOf: () => [], routesOf: () => [], skyOf: () => undefined }));

const mockListeners = new Set<() => void>();
const mockSessionCalls: string[] = [];
const mockSession = {
  setForeground: jest.fn(),
  focusLast: jest.fn(),
  back: jest.fn(() => (mockSessionCalls.push('back'), true)),
  canBack: jest.fn(() => false),
  escape: jest.fn(() => (mockSessionCalls.push('escape'), true)),
  subscribe: jest.fn((listener: () => void) => {
    mockListeners.add(listener);
    return () => void mockListeners.delete(listener);
  }),
  getState: () => mockState,
  places: () => [],
  focus: jest.fn(),
  formation: { getState: () => ({ fact: undefined }) },
};
let mockState: Record<string, unknown> = {};
const stateAt = (focusId: string | null) => ({
  read: { status: 'ready', snapshot: {}, sky: undefined, loadedSystemIds: [] },
  dust: { cues: [], status: 'idle' },
  detail: 'high',
  overlay: null,
  selectedId: null,
  landed: false,
  absent: false,
  focusId,
});
jest.mock('./use-universe-session', () => ({ useUniverseSession: () => ({ session: mockSession, state: mockState }) }));

const scope = { active: true } as unknown as AccountScope;
const calm = (node: React.ReactElement) => (
  <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>{node}</DisplayProvider>
);

beforeEach(() => {
  mockTrialOn = true;
  mockState = stateAt(null);
  mockSeen.store = null;
  mockSeen.back = null;
  mockSeen.focus = null;
  mockSessionCalls.length = 0;
  mockListeners.clear();
  mockPush.mockReset();
  mockSession.canBack.mockReturnValue(false);
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
});

const backs = () => mockSeen.back as unknown as { back: () => boolean; escape: () => boolean; canBack: () => boolean };

describe('with the switch on', () => {
  it('makes the flag once for the screen and gives it to the tree', async () => {
    const view = await render(calm(<SignedInUniverse scope={scope} />));
    const first = mockSeen.store;
    expect(first).not.toBeNull();
    await view.rerender(calm(<SignedInUniverse scope={scope} />));
    expect(mockSeen.store).toBe(first);
  });

  it('takes a visit to a friend’s universe as a push to its route, handle encoded', async () => {
    await render(calm(<SignedInUniverse scope={scope} />));
    (mockSeen.surface['onFriend'] as (handle: string) => void)('mei.c/a');
    expect(mockPush).toHaveBeenCalledWith('/visit/mei.c%2Fa');
  });

  it('can go back at the outer stop, though the session has nothing to go back to', async () => {
    await render(calm(<SignedInUniverse scope={scope} />));
    expect(backs().canBack()).toBe(false);
    await act(() => mockSeen.store!.enter());
    expect(backs().canBack()).toBe(true);
  });

  it('goes back by the list first, then the stop, then the session’s own Back', async () => {
    await render(calm(<SignedInUniverse scope={scope} />));
    const store = mockSeen.store!;
    await act(() => {
      store.enter();
      store.openList();
    });
    expect(backs().back()).toBe(true);
    expect(store.getState()).toEqual({ on: true, listOpen: false });
    expect(backs().back()).toBe(true);
    expect(store.getState().on).toBe(false);
    expect(mockSessionCalls).toEqual([]);
    backs().back();
    expect(mockSessionCalls).toEqual(['back']);
  });

  it('answers Escape in the same order, then climbs as the new look’s Escape does', async () => {
    await render(calm(<SignedInUniverse scope={scope} />));
    const store = mockSeen.store!;
    await act(() => {
      store.enter();
      store.openList();
    });
    expect(backs().escape()).toBe(true);
    expect(store.getState()).toEqual({ on: true, listOpen: false });
    expect(backs().escape()).toBe(true);
    expect(store.getState().on).toBe(false);
    expect(mockSessionCalls).toEqual([]);
    backs().escape();
    // `escapeOneStop` on a map with nothing open hands it to the session's own Escape.
    expect(mockSessionCalls).toEqual(['escape']);
  });

  it('tells the web history marker of both changes: the session’s and the stop’s', async () => {
    await render(calm(<SignedInUniverse scope={scope} />));
    const heard = jest.fn();
    const stop = (mockSeen.back as unknown as { subscribe: (l: () => void) => () => void }).subscribe(heard);
    await act(() => mockSeen.store!.enter());
    expect(heard).toHaveBeenCalledTimes(1);
    for (const listener of mockListeners) listener();
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    expect(mockListeners.size).toBe(0);
  });

  it('leaves the stop when the screen blurs, and when the app goes to the background', async () => {
    await render(calm(<SignedInUniverse scope={scope} />));
    const store = mockSeen.store!;
    let cleanup = () => {};
    await act(() => {
      cleanup = mockSeen.focus!() as () => void;
    });
    await act(() => store.enter());
    // Blur: the stop is left once the rest of the blur has run (Back's own cleanup stops listening first).
    await act(() => {
      cleanup();
      expect(store.getState().on).toBe(true);
    });
    expect(store.getState().on).toBe(false);
    // The app goes to the background.
    const change = jest.spyOn(AppState, 'addEventListener');
    await act(() => {
      mockSeen.focus!();
    });
    const onChange = change.mock.calls.at(-1)![1] as (value: string) => void;
    await act(() => store.enter());
    await act(() => onChange('background'));
    expect(store.getState().on).toBe(false);
    change.mockRestore();
  });

  it('leaves the stop whenever anything moves to a place, and not while it is at the whole universe', async () => {
    const view = await render(calm(<SignedInUniverse scope={scope} />));
    const store = mockSeen.store!;
    await act(() => store.enter());
    expect(store.getState().on).toBe(true);
    mockState = stateAt('some-system');
    await view.rerender(calm(<SignedInUniverse scope={scope} />));
    expect(store.getState().on).toBe(false);
  });
});

describe('with the switch off', () => {
  it('gives the tree no store and hands the session to Back verbatim, as it always was', async () => {
    mockTrialOn = false;
    await render(calm(<SignedInUniverse scope={scope} />));
    expect(mockSeen.store).toBeNull();
    expect(mockSeen.back).toBe(mockSession);
    expect(backs().canBack).toBe(mockSession.canBack);
    expect(backs().back).toBe(mockSession.back);
    expect(backs().escape).toBe(mockSession.escape);
  });
});
