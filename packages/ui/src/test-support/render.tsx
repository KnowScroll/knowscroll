import { render, type RenderResult } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';
import type { ReactElement } from 'react';
import { DisplayProvider, type Display } from '../display/display';

/**
 * Renders under a pinned display. React Native's Jest preset reports a 750 px window at 200 %
 * text, which would put every component in its tablet and large-text layouts; tests choose the
 * display they mean instead (default: a 390 px phone at 100 % text, reduced motion on so
 * animations settle at once).
 */
export function renderOn(
  element: ReactElement,
  display: Partial<Pick<Display, 'width' | 'textScale' | 'reducedMotion'>> = {},
): Promise<RenderResult> {
  return render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true, ...display }}>{element}</DisplayProvider>,
  );
}

/**
 * Asserts a toggle button's pressed state. Testing Library computes `checked` only for checkbox,
 * radio and switch roles, so the state is read from the props screen readers receive.
 */
export function expectPressed(element: TestInstance, pressed: boolean): void {
  expect(element).toHaveProp('accessibilityRole', 'togglebutton');
  expect(element).toHaveProp('accessibilityState', expect.objectContaining({ checked: pressed }));
}
