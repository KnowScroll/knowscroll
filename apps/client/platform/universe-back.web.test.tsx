import type * as React from 'react';
import { act, type EffectCallback } from 'react';
import { createRoot } from 'test-renderer';
import { useUniverseBack } from '../features/universe/use-universe-back.web';
import { createUniverseViewSession } from '../features/universe/universe-session';
import { universeHarness, fixtureId } from '../features/universe/universe.fixture';
jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<typeof React>('react');
  return { useFocusEffect: (effect: EffectCallback) => useEffect(effect, [effect]) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('Back closes the panel before restoring a camera and unregisters; history carries only a transient marker', async () => {
  const h = universeHarness(),
    session = createUniverseViewSession(h.scope);
  session.setForeground(true);
  await new Promise<void>((resolve, reject) => {
    const off = session.subscribe(() => {
      if (session.getState().read.status === 'ready') {
        off();
        resolve();
      } else if (session.getState().read.status === 'unavailable') {
        off();
        reject(new Error('fixture_read_failed'));
      }
    });
  });
  function Host() {
    useUniverseBack(session, true);
    return null;
  }
  const push = jest.spyOn(window.history, 'pushState'),
    root = createRoot();
  act(() => root.render(<Host />));
  act(() => {
    session.focus(fixtureId(10));
    session.showOverlay('place');
  });
  expect(JSON.stringify(push.mock.calls)).not.toMatch(/objectId|frame|seed|CI system|0199a000/);
  window.history.replaceState({}, '', window.location.href);
  await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(session.getState().overlay).toBeNull();
  expect(session.getState().focusId).toBe(fixtureId(10));
  window.history.replaceState({}, '', window.location.href);
  await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(session.getState().focusId).toBeNull();
  act(() => root.unmount());
  const previous = session.getState();
  await act(() => window.dispatchEvent(new PopStateEvent('popstate')));
  expect(session.getState()).toBe(previous);
  h.scope.end();
  push.mockRestore();
});
