import type * as React from 'react';
import type { EffectCallback } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AppState, Platform, View as MockView } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';
import { visitServer } from '@knowscroll/client-core/visit-fixture';
import { DisplayProvider } from '@knowscroll/ui';
import { DevicePreferencesProvider } from '../../providers/device-preferences';
import { defaultDevicePreferences, type DevicePreferences } from '../account/device-preferences';
import type { CrossingFrame } from '../universe/crossing/crossing-frame';
import { FrameRateFigure as MockFrameRateFigure } from '../universe/frame-rate/frame-rate-readout';
import { markCrossingSeen } from './crossing-seen';
import { VisitScreen } from './visit-screen';

/**
 * The crossing over a visit, with the real screen, director, clock rules and layer, over stand-ins for what is drawn: the
 * film's stage (it records what it is given), the Universe's map (a surface with the visitor bar's Leave and the
 * readout), and the frame loop (stepped by hand). The browser proves the pixels and the real map (e2e/visit-smoke.spec.ts).
 */
let mockScope: AccountScope;
const mockNavigate = jest.fn();
const mockDismissTo = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockCanGoBack = true;
jest.mock('../../providers/account-scope', () => ({
  useAccountScope: () => ({ state: { status: 'signed_in', scope: mockScope } }),
  useAccountInitial: () => 'A',
}));
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]),
    useIsFocused: () => true,
    useRouter: () => ({
      navigate: mockNavigate,
      dismissTo: mockDismissTo,
      back: mockBack,
      replace: mockReplace,
      canGoBack: () => mockCanGoBack,
    }),
  };
});
jest.mock('expo-status-bar', () => ({ setStatusBarStyle: jest.fn() }));
jest.mock('../../platform/device-preferences-store', () => ({
  devicePreferencesStore: { read: () => null, write: () => undefined },
}));
let mockOwnLabels: readonly string[] | undefined;
jest.mock('./use-own-system-labels', () => ({ useOwnSystemLabels: () => mockOwnLabels }));

interface StageProps {
  frame: CrossingFrame;
  size: { width: number; height: number };
  behindSeed: string;
  aheadSeed: string;
  onFrameTime?: (frame: { atMs: number; drawMs: number }) => void;
}
let mockStage: StageProps | null = null;
jest.mock('../universe/crossing/crossing-stage', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return {
    CrossingStage: (props: StageProps) => {
      mockStage = props;
      // A drawn frame, as the real stage reports it.
      useEffect(() => props.onFrameTime?.({ atMs: performance.now(), drawMs: 1 }), [props]);
      return <MockView testID="stage-stub" />;
    },
  };
});
interface SurfaceProps {
  voyage?: boolean;
  visitor?: { bar: React.ReactNode };
}
jest.mock('../universe/universe-surface', () => ({
  UniverseSurface: ({ voyage, visitor }: SurfaceProps) => (
    <MockView testID="surface-stub" accessibilityLabel={voyage ? 'new look' : 'old look'}>
      {visitor?.bar}
      <MockFrameRateFigure />
    </MockView>
  ),
}));

// The frame loop, stepped by hand: `play(1.5)` is one and a half seconds of frames.
let pending = new Map<number, (nowMs: number) => void>();
let nextHandle = 1;
let clockMs = 1000;
beforeEach(() => {
  jest.clearAllMocks();
  mockStage = null;
  mockOwnLabels = undefined;
  mockCanGoBack = true;
  pending = new Map();
  nextHandle = 1;
  clockMs = 1000;
  Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  jest.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    return handle;
  });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((handle) => {
    pending.delete(handle ?? -1);
  });
});
afterEach(() => jest.restoreAllMocks());

/** Delivers one frame of the loop. */
const frame = () => {
  clockMs += 40;
  const waiting = [...pending.values()];
  pending.clear();
  return act(() => waiting.forEach((callback) => callback(clockMs)));
};
/** Seconds of the film's own clock, in frames of 40 ms: the first frame after a start sets the clock at 0. */
const play = async (seconds: number) => {
  for (let step = 0; step < Math.round(seconds / 0.04); step += 1) await frame();
};
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
/** The white of the arrival fades for 0.3 s of real time (the animation runs on timers, not on the frame loop). */
const fade = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))));

const preferences = (over: Partial<DevicePreferences> = {}): DevicePreferences => ({
  ...defaultDevicePreferences,
  ...over,
});
const tree = (handle = 'fixture.ravi', over: Partial<DevicePreferences> = {}, reducedMotion = false) => (
  <DevicePreferencesProvider initial={preferences(over)}>
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion }}>
      <VisitScreen handle={handle} />
    </DisplayProvider>
  </DevicePreferencesProvider>
);
const lay = () =>
  fireEvent(screen.getByTestId('visit-crossing'), 'layout', { nativeEvent: { layout: { width: 390, height: 844 } } });
const NEW_LOOK = { universeTrial: true };
const READ = '/v1/social/visits/read';

/**
 * The visit read held until the test lets it go, so what the film does before an answer can be seen. Returns the scope to
 * visit with (the server's, answering through a gate) and the way to open the gate.
 */
function holdTheRead(server: ReturnType<typeof visitServer>) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const sharing = new Proxy(server.scope.api.sharing, {
    get: (target, key, receiver): unknown =>
      key === 'visit'
        ? async (...args: Parameters<typeof target.visit>) => {
            await gate;
            return target.visit(...args);
          }
        : (Reflect.get(target, key, receiver) as unknown),
  });
  const api = new Proxy(server.scope.api, {
    get: (target, key, receiver): unknown =>
      key === 'sharing' ? sharing : (Reflect.get(target, key, receiver) as unknown),
  });
  mockScope = new Proxy(server.scope, {
    get: (target, key, receiver): unknown => (key === 'api' ? api : (Reflect.get(target, key, receiver) as unknown)),
  });
  return async () => {
    release();
    await settle();
  };
}

const announcement = () => screen.queryByTestId('visit-crossing-announcement');

describe('with the new look on: the crossing to a friend', () => {
  it('plays the film over the visit’s loading when the screen first mounts, with the friend’s name once the read has it', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const letGo = holdTheRead(server);
    const rendered = await render(tree('fixture.ravi', NEW_LOOK));
    await lay();
    await play(0.2);
    expect(screen.getByTestId('visit-crossing-film')).toBeOnTheScreen();
    expect(mockStage!.frame.q).toBeGreaterThan(0);
    expect(mockStage).toMatchObject({ behindSeed: 'you', aheadSeed: 'friend:fixture.ravi' });
    // Before the read has answered the film does not know the name, and says so plainly.
    expect(mockStage!.frame.labels.map((label) => label.text)).toContain('Setting course for your friend’s universe');
    await letGo();
    await play(0.2);
    expect(mockStage!.frame.labels.map((label) => label.text)).toContain('Setting course for Ravi fixture’s universe');
    expect(screen.getByRole('button', { name: 'Skip the crossing' })).toBeOnTheScreen();
    await rendered.unmount();
    server.scope.end();
  });

  it('says where you are going once, in a live region that was already there', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const letGo = holdTheRead(server);
    await render(tree('fixture.ravi', NEW_LOOK));
    const line = screen.getByTestId('visit-crossing-line');
    expect(line.props.accessibilityLiveRegion).toBe('polite');
    expect(announcement()).toBeNull();
    await letGo();
    await play(0.1);
    expect(announcement()).toHaveTextContent('Going to Ravi fixture’s universe');
    // The same element took the text: the region itself was never removed or remade.
    expect(screen.getByTestId('visit-crossing-line')).toBe(line);
    await play(3);
    expect(announcement()).toHaveTextContent('Going to Ravi fixture’s universe');
    await play(5);
    await fade();
    // Over: the line is cleared and the region stays.
    expect(announcement()).toBeNull();
    expect(screen.getByTestId('visit-crossing-line')).toBe(line);
  });

  it('keeps the skip target mounted, with the same role, when the film is not playing, hidden and letting touches through', async () => {
    const server = visitServer();
    mockScope = server.scope;
    await render(tree('fixture.ravi', NEW_LOOK));
    await settle();
    await lay();
    const playing = screen.getByTestId('visit-crossing-skip');
    expect(playing.props.accessibilityRole).toBe('button');
    expect(playing.props.tabIndex).toBe(-1);
    await play(9);
    const idle = screen.getByTestId('visit-crossing-skip', { includeHiddenElements: true });
    expect(idle).toBe(playing);
    expect(idle.props.accessibilityRole).toBe('button');
    expect(idle.props.tabIndex).toBe(-1);
    expect(idle.props['aria-hidden']).toBe(true);
    expect(idle.props.pointerEvents).toBe('none');
  });

  it('draws the map under it, in the new look, ready for the flash to end over', async () => {
    const server = visitServer();
    mockScope = server.scope;
    await render(tree('fixture.ravi', NEW_LOOK));
    await settle();
    expect(screen.getByLabelText('new look')).toBeOnTheScreen();
    await lay();
    await play(7.6);
    expect(screen.getByTestId('visit-crossing-arrival')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Leave this visit' })).toBeOnTheScreen();
  });

  it('starts only on the first mount: not again when the screen is drawn again, nor when a switch changes under it', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(tree('fixture.ravi', NEW_LOOK));
    await settle();
    await lay();
    await play(9);
    expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
    await rendered.rerender(tree('fixture.ravi', NEW_LOOK));
    await rendered.rerender(tree('fixture.ravi', { ...NEW_LOOK, universeFrameRate: true }));
    await play(1);
    expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
    expect(screen.queryByTestId('visit-crossing-cut')).toBeNull();
    await rendered.unmount();
    server.scope.end();
  });

  it('is a new film for another friend', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(tree('fixture.ravi', NEW_LOOK));
    await settle();
    await lay();
    await play(9);
    expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
    await rendered.rerender(tree('fixture.meera', NEW_LOOK));
    await settle();
    await lay();
    await play(0.2);
    expect(screen.getByTestId('visit-crossing-film')).toBeOnTheScreen();
    expect(mockStage).toMatchObject({ aheadSeed: 'friend:fixture.meera' });
  });

  describe('how long it takes', () => {
    it('is 7.5 s the first time for a friend and 3.6 s after, kept on this device for this account', async () => {
      const server = visitServer();
      mockScope = server.scope;
      const first = await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(3.7);
      // 3.7 s into the first film: still playing.
      expect(screen.getByTestId('visit-crossing-film')).toBeOnTheScreen();
      expect(mockStage!.frame.q).toBeCloseTo(3.7 / 7.5, 1);
      await play(4);
      expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
      expect(JSON.parse(mockScope.storage.get('universe.crossing-seen.v1') ?? '{}')).toEqual({
        handles: ['fixture.ravi'],
      });
      await first.unmount();

      const second = await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(1.8);
      expect(mockStage!.frame.q).toBeCloseTo(1.8 / 3.6, 1);
      await play(2);
      expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
      await second.unmount();

      // Another friend is a first time again.
      const other = await render(tree('fixture.meera', NEW_LOOK));
      await settle();
      await lay();
      await play(3.7);
      expect(screen.getByTestId('visit-crossing-film')).toBeOnTheScreen();
      await other.unmount();
      server.scope.end();
    });

    it('does not count a film that was stopped before it began to show anything as seen', async () => {
      const server = visitServer();
      server.setAllowed(false);
      mockScope = server.scope;
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(1);
      expect(mockScope.storage.get('universe.crossing-seen.v1')).toBeUndefined();
    });

    it('starts the short film for a friend already marked seen', async () => {
      const server = visitServer();
      mockScope = server.scope;
      markCrossingSeen(mockScope, 'fixture.ravi');
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(1.8);
      expect(mockStage!.frame.q).toBeCloseTo(0.5, 1);
    });
  });

  describe('when the other universe cannot be reached', () => {
    it('stops the film before q 0.3 and shows today’s screen', async () => {
      const server = visitServer();
      server.setAllowed(false);
      mockScope = server.scope;
      const letGo = holdTheRead(server);
      await render(tree('fixture.ravi', NEW_LOOK));
      await lay();
      await play(1.5);
      expect(screen.getByTestId('visit-crossing-film')).toBeOnTheScreen();
      await letGo();
      expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
      expect(screen.getByText('This universe isn’t shared with you')).toBeOnTheScreen();
      expect(announcement()).toBeNull();
    });

    it('lets the film finish when the answer comes after q 0.3, and the screen is under it', async () => {
      const server = visitServer();
      server.setAllowed(false);
      mockScope = server.scope;
      const letGo = holdTheRead(server);
      await render(tree('fixture.ravi', NEW_LOOK));
      await lay();
      await play(2.4);
      await letGo();
      expect(screen.getByTestId('visit-crossing-film')).toBeOnTheScreen();
      await play(6);
      expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
      expect(screen.getByText('This universe isn’t shared with you')).toBeOnTheScreen();
    });

    it('stops it for a lost connection before q 0.3, and plays none when the device says it is offline', async () => {
      const server = visitServer();
      server.failNext(READ, 'network');
      mockScope = server.scope;
      const letGo = holdTheRead(server);
      const rendered = await render(tree('fixture.ravi', NEW_LOOK));
      await lay();
      await play(0.5);
      await letGo();
      expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
      expect(screen.getByText('You’re offline')).toBeOnTheScreen();
      await rendered.unmount();

      Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
      try {
        const offline = visitServer();
        mockScope = offline.scope;
        await render(tree('fixture.meera', NEW_LOOK));
        await settle();
        await lay();
        await play(0.2);
        expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
      } finally {
        Reflect.deleteProperty(globalThis.navigator, 'onLine');
      }
    });
  });

  describe('the names you have in common', () => {
    const framesNames = () => mockStage!.frame.names.map((name) => name.text);

    it('drift past when the read was back by q 0.47', async () => {
      const server = visitServer();
      mockScope = server.scope;
      mockOwnLabels = ['machine LEARNING', 'Baking'];
      const letGo = holdTheRead(server);
      await render(tree('fixture.ravi', NEW_LOOK));
      await lay();
      await play(3);
      await letGo();
      await play(1.2);
      expect(mockStage!.frame.q).toBeGreaterThan(0.5);
      expect(framesNames()).toEqual(['Machine learning']);
      expect(mockStage!.frame.labels.map((label) => label.text)).toContain('What you have in common');
    });

    it('are none when the read came after it, and the film is not held for them', async () => {
      const server = visitServer();
      mockScope = server.scope;
      mockOwnLabels = ['Machine learning'];
      const letGo = holdTheRead(server);
      await render(tree('fixture.ravi', NEW_LOOK));
      await lay();
      await play(4);
      expect(mockStage!.frame.q).toBeGreaterThan(0.5);
      await letGo();
      await play(0.4);
      expect(framesNames()).toEqual([]);
      // Not held: the film is where its clock says.
      expect(mockStage!.frame.q).toBeCloseTo(4.4 / 7.5, 1);
    });

    it('are none when your own names are not in hand', async () => {
      const server = visitServer();
      mockScope = server.scope;
      mockOwnLabels = undefined;
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(4);
      expect(framesNames()).toEqual([]);
    });
  });

  describe('skipping', () => {
    it('goes to the end of the film on a tap anywhere, then the white lets go over the map', async () => {
      const server = visitServer();
      mockScope = server.scope;
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(1);
      await fireEvent.press(screen.getByTestId('visit-crossing-skip'));
      expect(mockStage!.frame.q).toBeCloseTo(0.985);
      await play(0.4);
      expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
      expect(screen.getByTestId('visit-crossing-arrival')).toBeOnTheScreen();
      expect(screen.getByRole('button', { name: 'Leave this visit' })).toBeOnTheScreen();
      expect(JSON.parse(mockScope.storage.get('universe.crossing-seen.v1') ?? '{}')).toEqual({
        handles: ['fixture.ravi'],
      });
    });

    it('goes to the end on Escape on the web, and the key is let go when the film is over', async () => {
      const server = visitServer();
      mockScope = server.scope;
      const keys = new Map<string, (event: { key: string }) => void>();
      jest.replaceProperty(Platform, 'OS', 'web');
      jest.replaceProperty(globalThis, 'window', {
        addEventListener: (type: string, handler: (event: { key: string }) => void) => keys.set(type, handler),
        removeEventListener: (type: string) => keys.delete(type),
      } as unknown as Window & typeof globalThis);
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(1);
      expect(keys.has('keydown')).toBe(true);
      await act(() => keys.get('keydown')!({ key: 'Tab' }));
      expect(mockStage!.frame.q).toBeLessThan(0.5);
      await act(() => keys.get('keydown')!({ key: 'Escape' }));
      expect(mockStage!.frame.q).toBeCloseTo(0.985);
      await play(0.4);
      expect(keys.has('keydown')).toBe(false);
    });
  });

  describe('reduced motion', () => {
    it('is a dark cut of about a quarter of a second, with no film and no white, then the map', async () => {
      const server = visitServer();
      mockScope = server.scope;
      await render(tree('fixture.ravi', NEW_LOOK, true));
      await settle();
      await lay();
      await play(0.04);
      expect(screen.getByTestId('visit-crossing-cut')).toBeOnTheScreen();
      expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
      expect(mockStage).toBeNull();
      await play(0.4);
      expect(screen.queryByTestId('visit-crossing-cut')).toBeNull();
      expect(screen.queryByTestId('visit-crossing-arrival')).toBeNull();
      expect(screen.getByRole('button', { name: 'Leave this visit' })).toBeOnTheScreen();
      // No film was seen, so the long one is still to come.
      expect(mockScope.storage.get('universe.crossing-seen.v1')).toBeUndefined();
    });

    it('cuts on the way home too, and then lands on your Universe', async () => {
      const server = visitServer();
      mockScope = server.scope;
      await render(tree('fixture.ravi', NEW_LOOK, true));
      await settle();
      await lay();
      await play(0.5);
      await fireEvent.press(await screen.findByRole('button', { name: 'Leave this visit' }));
      await play(0.04);
      expect(screen.getByTestId('visit-crossing-cut')).toBeOnTheScreen();
      expect(mockDismissTo).not.toHaveBeenCalled();
      await play(0.4);
      expect(mockDismissTo).toHaveBeenCalledWith('/universe');
    });
  });

  describe('Leave', () => {
    it('plays the film home, then lands on your Universe, and does not go back to Friends or the chat', async () => {
      const server = visitServer();
      mockScope = server.scope;
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(9);
      await fireEvent.press(screen.getByRole('button', { name: 'Leave this visit' }));
      await play(0.1);
      expect(announcement()).toHaveTextContent('Going home');
      expect(screen.getByTestId('visit-crossing-film')).toBeOnTheScreen();
      expect(mockStage).toMatchObject({ behindSeed: 'friend:fixture.ravi', aheadSeed: 'you' });
      expect(mockStage!.frame.labels.map((label) => label.text)).toContain('Setting course for home');
      // A second press while it plays does not start it again.
      await fireEvent.press(screen.getByRole('button', { name: 'Leave this visit' }));
      await play(1.8);
      expect(mockStage!.frame.q).toBeCloseTo(0.5, 1);
      expect(mockDismissTo).not.toHaveBeenCalled();
      await play(2.2);
      expect(mockDismissTo).toHaveBeenCalledTimes(1);
      expect(mockDismissTo).toHaveBeenCalledWith('/universe');
      expect(mockBack).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
      // No names in the film home.
      expect(mockStage!.frame.names).toEqual([]);
    });

    it('can be skipped, and still lands on your Universe', async () => {
      const server = visitServer();
      mockScope = server.scope;
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(9);
      await fireEvent.press(screen.getByRole('button', { name: 'Leave this visit' }));
      await play(0.5);
      await fireEvent.press(screen.getByTestId('visit-crossing-skip'));
      await play(0.3);
      expect(mockDismissTo).toHaveBeenCalledWith('/universe');
    });

    it('leaves the screens for a refusal and for no connection as they were: back, or Friends', async () => {
      const server = visitServer();
      server.setAllowed(false);
      mockScope = server.scope;
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await fireEvent.press(await screen.findByRole('link', { name: 'Back to Friends' }));
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(mockDismissTo).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalledWith('/universe');
    });
  });

  describe('the frame-rate readout', () => {
    it('is given the film’s frames when it is on, and nothing when it is off', async () => {
      const server = visitServer();
      mockScope = server.scope;
      await render(tree('fixture.ravi', NEW_LOOK));
      await settle();
      await lay();
      await play(0.2);
      expect(mockStage!.onFrameTime).toBeUndefined();
      expect(screen.queryByTestId('universe-frame-rate')).toBeNull();
    });

    it('shows the film as one flight, with its frames, after it', async () => {
      const server = visitServer();
      mockScope = server.scope;
      await render(tree('fixture.ravi', { ...NEW_LOOK, universeFrameRate: true }));
      await settle();
      await lay();
      await play(0.2);
      expect(mockStage!.onFrameTime).toEqual(expect.any(Function));
      await play(8);
      // The figure redraws twice a second.
      await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 700))));
      expect(screen.getByTestId('universe-frame-rate')).toHaveTextContent(/crossing · /);
    });
  });
});

describe('with the switch off: no film, ever, and Leave as it always was', () => {
  it('draws no film, no cut, no white and no skip target, and reads nothing of your own', async () => {
    const server = visitServer();
    mockScope = server.scope;
    const rendered = await render(tree('fixture.ravi'));
    await settle();
    await play(1);
    expect(screen.queryByTestId('visit-crossing')).toBeNull();
    expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
    expect(screen.queryByTestId('visit-crossing-skip')).toBeNull();
    expect(screen.queryByTestId('visit-crossing-line')).toBeNull();
    expect(screen.getByLabelText('old look')).toBeOnTheScreen();
    expect(pending.size).toBe(0);
    expect(mockScope.storage.get('universe.crossing-seen.v1')).toBeUndefined();
    await rendered.unmount();
    server.scope.end();
  });

  it('plays none under reduced motion either, nor with the frame-rate readout on', async () => {
    const server = visitServer();
    mockScope = server.scope;
    await render(tree('fixture.ravi', { universeFrameRate: true }, true));
    await settle();
    await play(1);
    expect(screen.queryByTestId('visit-crossing-cut')).toBeNull();
    expect(screen.queryByTestId('visit-crossing')).toBeNull();
  });

  it('Leave goes back, or to Friends when there is nothing to go back to, and never to your Universe', async () => {
    const server = visitServer();
    mockScope = server.scope;
    await render(tree('fixture.ravi'));
    await fireEvent.press(await screen.findByRole('button', { name: 'Leave this visit' }));
    expect(mockBack).toHaveBeenCalledTimes(1);
    mockCanGoBack = false;
    await fireEvent.press(screen.getByRole('button', { name: 'Leave this visit' }));
    expect(mockReplace).toHaveBeenCalledWith('/friends');
    expect(mockDismissTo).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalledWith('/universe');
    expect(screen.queryByTestId('visit-crossing-film')).toBeNull();
  });
});
