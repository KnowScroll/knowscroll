import type * as React from 'react';
import { act, type EffectCallback } from 'react';
import { createRoot } from 'test-renderer';
import { useEncounterBack } from '../features/encounter/use-encounter-back.web';
import type { EncounterSession, EncounterState } from '../features/encounter/encounter-session';
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return { useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
describe('browser Back consumes a local encounter step, overlays first', () => {
  it('never treats overlay Back as another encounter step and does not write private data into history', async () => {
    const listeners = new Set<() => void>();
    let depth = 1;
    let overlay = false;
    const back = jest.fn(() => {
      if (overlay) {
        overlay = false;
        return true;
      }
      if (depth > 1) {
        depth -= 1;
        return true;
      }
      return false;
    });
    const session = {
      back,
      canBack: () => depth > 1,
      getState: () =>
        ({ trail: Array.from({ length: depth }), overlay, phase: 'active', surfaceRevision: 0 }) as EncounterState,
      subscribe: (callback: () => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    } as unknown as EncounterSession;
    function Host() {
      useEncounterBack(session, true);
      return null;
    }
    const push = jest.spyOn(window.history, 'pushState');
    const root = createRoot();
    act(() => root.render(<Host />));
    depth = 2;
    act(() => listeners.forEach((listener) => listener()));
    expect(JSON.stringify(push.mock.calls.at(-1)?.[0])).toContain('ksEncounter');
    expect(JSON.stringify(push.mock.calls)).not.toMatch(/exposureId|positionMs|offerId|grant/);
    overlay = true;
    window.history.replaceState({}, '', window.location.href);
    await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(depth).toBe(2);
    expect(overlay).toBe(false);
    window.history.replaceState({}, '', window.location.href);
    await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(depth).toBe(1);
    act(() => root.unmount());
    window.history.replaceState({}, '', window.location.href);
    await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(back).toHaveBeenCalledTimes(2);
    push.mockRestore();
  });

  it('pops its marker once when several state changes land before the popstate (sheet action that navigates)', () => {
    const listeners = new Set<() => void>();
    let overlay = true;
    const session = {
      back: () => false,
      canBack: () => false,
      getState: () => ({ trail: [{}], overlay, phase: 'active', surfaceRevision: 0 }) as unknown as EncounterState,
      subscribe: (callback: () => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    } as unknown as EncounterSession;
    function Host() {
      useEncounterBack(session, true);
      return null;
    }
    const back = jest.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const root = createRoot();
    act(() => root.render(<Host />));
    // The sheet closes and the action navigates in the same turn: two publishes, one marker.
    overlay = false;
    act(() => listeners.forEach((listener) => listener()));
    act(() => listeners.forEach((listener) => listener()));
    expect(back).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    back.mockRestore();
  });
});
