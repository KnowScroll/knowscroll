import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createApiClient } from '@knowscroll/client-core';
import { problemDetails, PROBLEM_MEDIA_TYPE } from '@knowscroll/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import * as SafeArea from 'react-native-safe-area-context';
import { DisplayProvider } from '@knowscroll/ui';
import { SignedInExplore } from '../explore/explore-screen';
import { AppState, type AppStateStatus } from 'react-native';
import { harness } from '../encounter/encounter-session.fixture';
import { useCallback, useSyncExternalStore } from 'react';
import type * as React from 'react';
import type * as Native from 'react-native';
import { useVideoPlayer, type VideoPlayer } from 'expo-video';
import { EncounterView } from '../encounter/encounter-view';
import { ReelPage, createReelViewport, observeReelPageStage } from './reel-page';

// Native host/SDK boundaries only. Real ReelPage observer, EncounterView, activated view,
// encounter controller and shared ReelPlayer all execute in the composed fixtures below.
let mockMeasureNative = false;
const mockNativeMeasurements: { kind: 'page' | 'stage'; callback: Measurement }[] = [];
jest.mock('react-native', () => {
  const actual = jest.requireActual<typeof Native>('react-native');
  const react = jest.requireActual<typeof React>('react');
  const Host = actual.View;
  const MeasuredView = react.forwardRef(
    (props: Native.ViewProps, ref: React.ForwardedRef<{ measureInWindow(callback: Measurement): void }>) => {
      react.useImperativeHandle(
        ref,
        () => ({
          measureInWindow(callback: Measurement) {
            if (mockMeasureNative)
              mockNativeMeasurements.push({ kind: props.testID === 'native-resume-page' ? 'page' : 'stage', callback });
          },
        }),
        [props.testID],
      );
      return react.createElement(Host, props);
    },
  );
  const mocked = Object.create(actual) as typeof Native;
  Object.defineProperty(mocked, 'View', { value: MeasuredView, enumerable: true });
  return mocked;
});
jest.mock('expo-video', () => ({ VideoView: 'VideoView', useVideoPlayer: jest.fn() }));

jest.mock('expo-router', () => ({
  useFocusEffect: jest.fn(),
  useRouter: () => ({ canGoBack: () => false, back: jest.fn() }),
}));

type Measurement = (x: number, y: number, width: number, height: number) => void;
const page = { left: 0, top: 100, right: 355, bottom: 500 }; // Already excludes header/safe/tab regions.
function geometry() {
  const h = harness(),
    store = createReelViewport(),
    pause = jest.fn(),
    changed = jest.fn();
  const pending: Measurement[] = [];
  const observer = observeReelPageStage(
    store,
    h.scope,
    true,
    pause,
    (callback) => {
      pending.push(callback);
    },
    changed,
  );
  const finish = (y: number, height = 300) => {
    const callback = pending.at(-1);
    if (!callback) throw new Error('Native stage measurement required');
    callback(0, y, 355, height);
  };
  const layout = () => {
    const revision = store.invalidate();
    store.measured(revision, page);
  };
  return { ...h, store, pause, changed, pending, observer, finish, layout };
}

describe('actual native Reel viewport authority (labelled geometry callbacks, not native pixels)', () => {
  const changes: ((state: AppStateStatus) => void)[] = [];
  const original = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  beforeEach(() => {
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    changes.length = 0;
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      changes.push(listener);
      return { remove: jest.fn() };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (original) Object.defineProperty(AppState, 'currentState', original);
  });
  it('requires a measured stage intersection, revokes synchronously on scroll and rejects stale stage/page callbacks', () => {
    const h = geometry();
    try {
      expect(h.changed).toHaveBeenLastCalledWith(false);
      h.layout();
      h.finish(120);
      expect(h.changed).toHaveBeenLastCalledWith(true);
      h.observer.layout();
      const oldStage = h.pending.at(-1)!;
      const oldPageRevision = h.store.invalidate();
      expect(h.changed).toHaveBeenLastCalledWith(false);
      expect(h.pause).toHaveBeenCalled();
      const newPageRevision = h.store.invalidate();
      h.store.measured(oldPageRevision, page);
      expect(h.store.read().bounds).toBeNull();
      oldStage(0, 120, 355, 300);
      expect(h.changed).toHaveBeenLastCalledWith(false);
      h.store.measured(newPageRevision, page);
      h.finish(501);
      expect(h.changed).toHaveBeenLastCalledWith(false);
      h.observer.layout();
      h.finish(-51);
      expect(h.changed).toHaveBeenLastCalledWith(false); // Less than half of the stage below the header.
      h.observer.layout();
      h.finish(350);
      expect(h.changed).toHaveBeenLastCalledWith(true); // Exactly half is inside the real viewport.
      h.observer.layout();
      h.finish(Number.NaN);
      expect(h.changed).toHaveBeenLastCalledWith(false);
    } finally {
      h.observer.stop();
      h.scope.end();
    }
  });
  it('fences resize, background, route park, scope disposal and unmount without restoring old callbacks', () => {
    const h = geometry();
    try {
      h.layout();
      h.finish(120);
      h.observer.layout();
      const beforeBackground = h.pending.at(-1)!;
      changes.at(-1)!('background');
      expect(h.changed).toHaveBeenLastCalledWith(false);
      beforeBackground(0, 120, 355, 300);
      expect(h.changed).toHaveBeenLastCalledWith(false);
      changes.at(-1)!('active');
      h.finish(120);
      expect(h.changed).toHaveBeenLastCalledWith(true);
      h.observer.layout();
      const beforeResize = h.pending.at(-1)!;
      const revision = h.store.invalidate();
      h.store.measured(revision, { ...page, bottom: 200 });
      beforeResize(0, 120, 355, 300);
      expect(h.changed).toHaveBeenLastCalledWith(false);
      h.finish(120);
      expect(h.changed).toHaveBeenLastCalledWith(false); // Only80px of300 visible after the resize.
      h.observer.layout();
      const beforeDisposal = h.pending.at(-1)!;
      h.scope.end();
      expect(h.changed).toHaveBeenLastCalledWith(false);
      const calls = h.changed.mock.calls.length;
      beforeDisposal(0, 100, 355, 50);
      expect(h.changed).toHaveBeenCalledTimes(calls);
      h.observer.stop();
      beforeDisposal(0, 100, 355, 50);
      expect(h.changed).toHaveBeenCalledTimes(calls);
    } finally {
      h.observer.stop();
      h.scope.end();
    }
  });
  it('keeps a throwing released-host measurement unavailable and fences its earlier queued callback', () => {
    const h = harness(),
      store = createReelViewport(),
      pause = jest.fn(),
      changed = jest.fn();
    const revision = store.invalidate();
    store.measured(revision, page);
    let previous: Measurement | undefined;
    const observer = observeReelPageStage(
      store,
      h.scope,
      true,
      pause,
      (callback) => {
        if (previous) throw new Error('labelled released native host');
        previous = callback;
      },
      changed,
    );
    try {
      observer.layout();
      expect(changed).toHaveBeenLastCalledWith(false);
      previous?.(0, 120, 355, 300);
      expect(changed).toHaveBeenLastCalledWith(false);
      expect(pause).toHaveBeenCalled();
    } finally {
      observer.stop();
      h.scope.end();
    }
  });
  it('never transfers a previous stage permission to a new scope object, or grants a parked route', () => {
    const h = geometry(),
      other = harness();
    try {
      h.layout();
      h.finish(120);
      h.observer.layout();
      const previous = h.pending.at(-1)!;
      h.observer.stop();
      const calls = h.changed.mock.calls.length;
      const pending: Measurement[] = [],
        changed = jest.fn(),
        pause = jest.fn();
      const parked = observeReelPageStage(
        h.store,
        other.scope,
        false,
        pause,
        (callback) => {
          pending.push(callback);
        },
        changed,
      );
      previous(0, 120, 355, 300);
      expect(h.changed).toHaveBeenCalledTimes(calls);
      expect(other.scope).not.toBe(h.scope);
      expect(other.scope.id).toBe(h.scope.id); // Textual scope identity cannot substitute for mounted authority.
      expect(changed).toHaveBeenLastCalledWith(false);
      expect(pending).toHaveLength(0);
      parked.stop();
      const current = observeReelPageStage(
        h.store,
        other.scope,
        true,
        pause,
        (callback) => {
          pending.push(callback);
        },
        changed,
      );
      expect(changed).toHaveBeenLastCalledWith(false);
      pending.at(-1)!(0, 120, 355, 300);
      expect(changed).toHaveBeenLastCalledWith(true);
      current.stop();
    } finally {
      h.observer.stop();
      h.scope.end();
      other.scope.end();
    }
  });
});

// Actual owning layout and actual scope/query resources; focus is parked, no encounter/network is opened.
describe('Explore page safe/tab composition', () => {
  it.each([
    [355, 130, 12],
    [768, 34, 0],
  ] as const)(
    'at width%s excludes the real navigation slot and positive safe areas before measuring native stages',
    async (width, bottom, left) => {
      const h = harness();
      jest.spyOn(SafeArea, 'useSafeAreaInsets').mockReturnValue({ top: 24, bottom: 34, left: 12, right: 9 });
      const app = await render(
        <DisplayProvider value={{ width, textScale: 1, reducedMotion: true }}>
          <QueryClientProvider client={h.scope.queryClient}>
            <SignedInExplore scope={h.scope} />
          </QueryClientProvider>
        </DisplayProvider>,
      );
      try {
        expect(screen.getByTestId('encounter-explore')).toHaveStyle({
          paddingTop: 24,
          paddingBottom: bottom,
          paddingLeft: left,
          paddingRight: 9,
        });
        expect(screen.getByTestId('encounter-page')).toHaveStyle({ flex: 1, minHeight: 0 });
        expect(h.calls).toHaveLength(0);
      } finally {
        await app.unmount();
        h.scope.end();
        jest.restoreAllMocks();
      }
    },
  );
});

/** Mirrors production's exposureId:surfaceRevision key, not an isolated player rerender. */
function NativeEncounterComposition({
  h,
  foreground = true,
}: {
  readonly h: ReturnType<typeof harness>;
  readonly foreground?: boolean;
}) {
  const subscribe = useCallback((listener: () => void) => h.session.subscribe(listener), [h]);
  const snapshot = useCallback(() => h.session.getState(), [h]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  if (!state.entry || state.phase === 'revoked') return null;
  return (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ReelPage testID="native-resume-page">
        <EncounterView
          key={`${state.entry.exposureId}:${state.surfaceRevision}`}
          scope={h.scope}
          entry={state.entry}
          state={state}
          session={h.session}
          foreground={foreground}
        />
      </ReelPage>
    </DisplayProvider>
  );
}
function nativeSDK() {
  const listeners = new Map<string, (event: unknown) => void>();
  const sdk = {
    currentTime: 0,
    playing: false,
    status: 'readyToPlay',
    playbackRate: 1,
    muted: false,
    play: jest.fn(() => {
      sdk.playing = true;
      listeners.get('playingChange')?.({ isPlaying: true });
    }),
    pause: jest.fn(() => {
      if (sdk.playing) {
        sdk.playing = false;
        listeners.get('playingChange')?.({ isPlaying: false });
      }
    }),
    replaceAsync: jest.fn((_source: unknown) => Promise.resolve()),
    addListener: (name: string, callback: (event: unknown) => void) => {
      listeners.set(name, callback);
      return {
        remove: () => {
          if (listeners.get(name) === callback) listeners.delete(name);
        },
      };
    },
  };
  jest.mocked(useVideoPlayer).mockReturnValue(sdk as unknown as VideoPlayer);
  return {
    sdk,
    complete() {
      listeners.get('playToEnd')?.({});
    },
    status(value: string) {
      sdk.status = value;
      listeners.get('statusChange')?.({ status: value });
    },
  };
}
function measurement(kind: 'page' | 'stage') {
  const pending = mockNativeMeasurements.filter((m) => m.kind === kind).at(-1);
  if (!pending) throw new Error(`Expected actual native ${kind} measurement`);
  return pending.callback;
}
async function commitNativePage() {
  const callback = measurement('page');
  await act(() => callback(0, 100, 355, 600));
}
async function commitNativeStage(visible = true) {
  const callback = measurement('stage');
  await act(() => callback(0, visible ? 120 : 900, 355, 200));
}
async function composedEncounter(playing = true, history = false) {
  const h = harness();
  const media = nativeSDK();
  h.session.setForeground(true);
  h.session.open({ kind: 'discover' });
  await waitFor(() => expect(h.session.getState().phase).toBe('active'));
  const entry = h.session.getState().entry!;
  if (history) {
    entry.restored = true;
    entry.position = { kind: 'reel', positionMs: 9000, playing: false, muted: true };
  }
  const app = await render(<NativeEncounterComposition h={h} />);
  await commitNativePage();
  await commitNativeStage();
  await waitFor(() => expect(entry.surface?.capture()?.kind).toBe('reel'));
  media.sdk.currentTime = history ? 9 : 12.5;
  if (playing) await fireEvent.press(screen.getByRole('button', { name: 'Play' }));
  return { h, entry, app, ...media };
}

describe('composed native Share close: actual viewport + encounter + shared SDK controller (CI fixture only)', () => {
  const activity: ((state: AppStateStatus) => void)[] = [];
  const original = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  beforeEach(() => {
    mockMeasureNative = true;
    mockNativeMeasurements.length = 0;
    activity.length = 0;
    Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, listener) => {
      activity.push(listener);
      return {
        remove: () => {
          const i = activity.indexOf(listener);
          if (i >= 0) activity.splice(i, 1);
        },
      };
    });
  });
  afterEach(() => {
    mockMeasureNative = false;
    mockNativeMeasurements.length = 0;
    jest.restoreAllMocks();
    if (original) Object.defineProperty(AppState, 'currentState', original);
  });
  it('survives actual observer cleanup/rebind pauses and resumes once only after the close generation is measured visible', async () => {
    const f = await composedEncounter();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Mute' }));
      const before = f.sdk.play.mock.calls.length,
        surface = f.h.session.getState().surfaceRevision;
      const loads = f.sdk.replaceAsync.mock.calls.filter(([source]) => source !== null).length;
      const commands = f.h.calls.filter(
        (c) => c.path.endsWith('/open') || c.path.endsWith('/activate') || c.path.endsWith('/grants'),
      ).length;
      await fireEvent.press(screen.getByRole('button', { name: 'Share' }));
      expect(f.sdk.playing).toBe(false);
      // history.park + the actual enabled=false native observer cleanup/start each pause.
      expect(f.sdk.pause.mock.calls.length).toBeGreaterThan(2);
      await act(() => f.h.session.setOverlay(false));
      expect(f.h.session.getState().surfaceRevision).toBe(surface);
      expect(f.sdk.play).toHaveBeenCalledTimes(before);
      const currentCloseMeasurement = measurement('stage');
      await act(() => currentCloseMeasurement(0, 120, 355, 200));
      expect(f.sdk.play).toHaveBeenCalledTimes(before + 1);
      expect(f.sdk.playing).toBe(true);
      expect(f.sdk.currentTime).toBe(12.5);
      expect(f.sdk.muted).toBe(true);
      await act(() => currentCloseMeasurement(0, 120, 355, 200));
      expect(f.sdk.play).toHaveBeenCalledTimes(before + 1);
      expect(f.sdk.replaceAsync.mock.calls.filter(([source]) => source !== null)).toHaveLength(loads);
      expect(
        f.h.calls.filter((c) => c.path.endsWith('/open') || c.path.endsWith('/activate') || c.path.endsWith('/grants')),
      ).toHaveLength(commands);
    } finally {
      await f.app.unmount();
      f.h.scope.end();
    }
  });
  it.each(['cold', 'history', 'paused'] as const)(
    'never resumes %s playback intent on geometry or share close',
    async (mode) => {
      const f = await composedEncounter(mode === 'paused', mode === 'history');
      try {
        if (mode === 'paused') await fireEvent.press(screen.getByRole('button', { name: 'Pause' }));
        const before = f.sdk.play.mock.calls.length;
        await fireEvent.press(screen.getByRole('button', { name: 'Share' }));
        await act(() => f.h.session.setOverlay(false));
        await commitNativeStage();
        expect(f.sdk.play).toHaveBeenCalledTimes(before);
        expect(f.sdk.playing).toBe(false);
      } finally {
        await f.app.unmount();
        f.h.scope.end();
      }
    },
  );
  it.each([
    'clipped',
    'viewport-revision',
    'background',
    'scope-end',
    'readiness',
    'replacement',
    'other-overlay',
    'failed-target',
    'new-target',
    'unavailable-entry',
    'corrected-entry',
  ] as const)('terminally cancels close intent for %s and later callbacks/readiness cannot autoplay', async (mode) => {
    const f = await composedEncounter();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Share' }));
      const before = f.sdk.play.mock.calls.length;
      if (mode === 'other-overlay') {
        const revision = f.h.session.getState().surfaceRevision;
        await act(() => f.h.session.setOverlay(true, 'path'));
        await act(() => f.h.session.setOverlay(false));
        expect(f.h.session.getState().surfaceRevision).toBe(revision + 1);
        await commitNativeStage();
      } else if (mode === 'failed-target') {
        f.h.setOpenFailure(true);
        await act(() => {
          f.h.session.openConversationContent(
            { assetId: '0199a000-0000-7000-8000-000000000999', assetRevision: 1 },
            jest.fn(),
          );
          f.h.session.setOverlay(false);
        });
        await waitFor(() => expect(f.h.session.getState().phase).toBe('offline'));
      } else {
        await act(() => f.h.session.setOverlay(false));
        const old = measurement('stage');
        if (mode === 'clipped') {
          await commitNativeStage(false);
          await fireEvent.scroll(screen.getByTestId('native-resume-page-scroll'), {
            nativeEvent: { contentOffset: { x: 0, y: 0 } },
          });
          await commitNativePage();
          await commitNativeStage();
        } else if (mode === 'viewport-revision') {
          await fireEvent.scroll(screen.getByTestId('native-resume-page-scroll'), {
            nativeEvent: { contentOffset: { x: 0, y: 5 } },
          });
          await act(() => old(0, 120, 355, 200));
          await commitNativePage();
          await commitNativeStage();
        } else if (mode === 'background') {
          await act(() => {
            f.h.session.setForeground(false);
            for (const notify of [...activity]) notify('background');
          });
          await act(() => old(0, 120, 355, 200));
          await act(() => {
            f.h.session.setForeground(true);
            for (const notify of [...activity]) notify('active');
          });
          await commitNativeStage();
        } else if (mode === 'scope-end') {
          await act(() => f.h.scope.end());
          await act(() => old(0, 120, 355, 200));
        } else if (mode === 'new-target') {
          await act(() => f.h.session.navigate({ mode: 'vertical', direction: 'next' }));
          await waitFor(() => {
            expect(f.h.session.getState().phase).toBe('active');
            expect(f.h.session.getState().entry).not.toBe(f.entry);
          });
          await act(() => old(0, 120, 355, 200));
          await commitNativeStage();
          await waitFor(() => expect(f.h.session.getState().entry?.surface?.capture()?.kind).toBe('reel'));
        } else if (mode === 'unavailable-entry') {
          f.h.setContextNotFound(true);
          await act(() => f.h.session.refreshContext());
          expect(f.h.session.getState().phase).toBe('revoked');
          await act(() => old(0, 120, 355, 200));
        } else if (mode === 'corrected-entry') {
          const client = createApiClient({
            baseUrl: 'https://ci-problem.invalid',
            fetch: () =>
              Promise.resolve(
                new Response(JSON.stringify(problemDetails('ASSET_REVISION_STALE')), {
                  status: 409,
                  headers: { 'content-type': PROBLEM_MEDIA_TYPE },
                }),
              ),
          });
          let problem: unknown;
          try {
            await client.experience.exposureContext({ exposureId: f.entry.exposureId });
          } catch (error) {
            problem = error;
          }
          await act(() => f.h.session.contextFailure(f.entry.exposureId, problem));
          expect(f.h.session.getState().phase).toBe('stale');
          await act(() => old(0, 120, 355, 200));
        } else {
          await act(() => f.status(mode === 'replacement' ? 'error' : 'loading'));
          await commitNativeStage();
          if (mode === 'replacement') {
            const loads = f.sdk.replaceAsync.mock.calls.filter(([source]) => source !== null).length;
            await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
            await waitFor(() =>
              expect(f.sdk.replaceAsync.mock.calls.filter(([source]) => source !== null).length).toBeGreaterThan(loads),
            );
          }
          await act(() => f.status('readyToPlay'));
          await act(() => old(0, 120, 355, 200));
        }
      }
      expect(f.sdk.play).toHaveBeenCalledTimes(before);
      expect(f.sdk.playing).toBe(false);
    } finally {
      await f.app.unmount();
      f.h.scope.end();
    }
  });
  it('cancels an outstanding close measurement instead of transferring it into a newer measurement generation', async () => {
    const f = await composedEncounter();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Share' }));
      await act(() => f.h.session.setOverlay(false));
      const before = f.sdk.play.mock.calls.length,
        old = measurement('stage');
      // A real native onLayout invalidates the binding's outstanding stage callback.
      await fireEvent(screen.getByTestId('encounter-reel-stage'), 'layout', {
        nativeEvent: { layout: { x: 0, y: 120, width: 355, height: 200 } },
      });
      await act(() => old(0, 120, 355, 200));
      await commitNativeStage();
      expect(f.sdk.play).toHaveBeenCalledTimes(before);
    } finally {
      await f.app.unmount();
      f.h.scope.end();
    }
  });
  it('never resumes a source completed by the actual SDK event while Share is parked, including later ready/current measurements', async () => {
    const f = await composedEncounter();
    try {
      await fireEvent.press(screen.getByRole('button', { name: 'Share' }));
      const plays = f.sdk.play.mock.calls.length,
        loads = f.sdk.replaceAsync.mock.calls.length,
        position = f.sdk.currentTime,
        commands = f.h.calls.filter(
          (call) => call.path.endsWith('/open') || call.path.endsWith('/activate') || call.path.endsWith('/grants'),
        ).length;
      const seek = jest.fn();
      Object.defineProperty(f.sdk, 'currentTime', { configurable: true, get: () => position, set: seek });
      await act(() => f.complete());
      await act(() => f.h.session.setOverlay(false));
      const current = measurement('stage');
      await act(() => current(0, 120, 355, 200));
      await act(() => f.status('readyToPlay'));
      await act(() => current(0, 120, 355, 200));
      await commitNativeStage();
      expect(f.sdk.play).toHaveBeenCalledTimes(plays);
      expect(f.sdk.playing).toBe(false);
      expect(f.sdk.replaceAsync).toHaveBeenCalledTimes(loads);
      expect(seek).not.toHaveBeenCalled();
      expect(
        f.h.calls.filter(
          (call) => call.path.endsWith('/open') || call.path.endsWith('/activate') || call.path.endsWith('/grants'),
        ),
      ).toHaveLength(commands);
    } finally {
      await f.app.unmount();
      f.h.scope.end();
    }
  });
});
