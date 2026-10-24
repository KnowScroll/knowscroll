import type * as React from 'react';
import { act, type EffectCallback } from 'react';
import { createRoot } from 'test-renderer';
import { useUniverseBack } from '../features/universe/use-universe-back.web';
import type { UniverseViewState } from '../features/universe/universe-session';

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return { useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
/** Adapter-only fixture. The real controller/core is exercised by native components and production Playwright. */
it('Back closes the panel before restoring a camera and unregisters; history carries only a transient marker', async () => {
  let state: UniverseViewState = {
    read: { status: 'ready', active: true },
    frame: { x: 10, y: 20, scale: 0.5 },
    focusId: 'private-fixture-id',
    overlay: null,
    detail: 'full',
    reducedMotion: true,
    historyDepth: 0,
    regionPreview: { status: 'idle' },
    lately: false,
    dust: { status: 'idle', cues: [] },
    lastPlace: undefined,
    absent: false,
    selectedId: null,
    youWereHere: null,
  };
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach((listener) => listener());
  const back = jest.fn(() => {
    if (state.overlay) state = { ...state, overlay: null };
    else if (state.historyDepth) state = { ...state, focusId: null, frame: { x: 0, y: 0, scale: 1 }, historyDepth: 0 };
    else return false;
    publish();
    return true;
  });
  const session = {
    back,
    getState: () => state,
    canBack: () => Boolean(state.overlay || state.historyDepth),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  function Host() {
    useUniverseBack(session, true);
    return null;
  }
  const push = jest.spyOn(window.history, 'pushState'),
    root = createRoot();
  act(() => root.render(<Host />));
  act(() => {
    state = { ...state, historyDepth: 1, overlay: 'place' };
    publish();
  });
  expect(JSON.stringify(push.mock.calls.at(-1)?.[0])).toContain('ksUniverse');
  expect(JSON.stringify(push.mock.calls)).not.toMatch(/objectId|frame|seed|private-fixture-id/);
  window.history.replaceState({}, '', window.location.href);
  await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(state.overlay).toBeNull();
  expect(state.historyDepth).toBe(1);
  expect(state.frame).toEqual({ x: 10, y: 20, scale: 0.5 });
  window.history.replaceState({}, '', window.location.href);
  await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(state.focusId).toBeNull();
  expect(state.frame).toEqual({ x: 0, y: 0, scale: 1 });
  act(() => root.unmount());
  await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(back).toHaveBeenCalledTimes(2);
  expect(listeners.size).toBe(0);
  push.mockRestore();
});

it('Escape closes a selected-system card as well as a panel', () => {
  const listeners = new Set<() => void>();
  let state = { overlay: null as string | null, selectedId: 'private-fixture-id' as string | null };
  const back = jest.fn(() => {
    state = { ...state, selectedId: null };
    listeners.forEach((listener) => listener());
    return true;
  });
  const session = {
    back,
    getState: () => state,
    canBack: () => Boolean(state.overlay || state.selectedId),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  function Host() {
    // The adapter only reads `overlay` and `selectedId`; the rest of the session is not used here.
    useUniverseBack(session as unknown as Parameters<typeof useUniverseBack>[0], true);
    return null;
  }
  const root = createRoot();
  act(() => root.render(<Host />));
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  expect(back).toHaveBeenCalledTimes(1);
  expect(state.selectedId).toBeNull();
  act(() => root.unmount());
});
