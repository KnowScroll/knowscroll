/**
 * Web (jest-expo/web, jsdom): a screen names the page when it gains focus (WCAG 2.4.2). Focus is
 * simulated here; the per-route titles of the real export are checked in a browser by the
 * Playwright smoke (`e2e/web-smoke.spec.ts`).
 */
import { act, type EffectCallback, type useEffect as UseEffect } from 'react';
import { createRoot } from 'test-renderer';
import { useDocumentTitle } from './document-title';

const mockFocusEffects: EffectCallback[] = [];

jest.mock('expo-router', () => {
  const { useEffect } = jest.requireActual<{ useEffect: typeof UseEffect }>('react');
  return {
    // Runs the effect like a screen gaining focus, and records it so the test can "refocus".
    useFocusEffect: (effect: EffectCallback) => {
      mockFocusEffects.push(effect);
      useEffect(effect, [effect]);
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Screen({ title }: { title: string }) {
  useDocumentTitle(title);
  return null;
}

describe('useDocumentTitle (web)', () => {
  it('sets "<screen> · KnowScroll" when the screen gains focus', () => {
    const root = createRoot();
    act(() => root.render(<Screen title="Keep" />));
    expect(document.title).toBe('Keep · KnowScroll');

    act(() => root.render(<Screen title="Talk" />));
    expect(document.title).toBe('Talk · KnowScroll');
    act(() => root.unmount());
  });

  it('sets it again when a screen that stayed mounted is focused again (tabs)', () => {
    const root = createRoot();
    act(() => root.render(<Screen title="Explore" />));
    document.title = 'Universe · KnowScroll';

    act(() => {
      mockFocusEffects.at(-1)?.();
    });

    expect(document.title).toBe('Explore · KnowScroll');
    act(() => root.unmount());
  });
});
