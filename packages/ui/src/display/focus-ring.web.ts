import type { ViewStyle } from 'react-native';
import { focusRing, type FocusTone } from '@knowscroll/design-tokens';

export interface FocusRing {
  readonly props: { onFocus: () => void; onBlur: () => void };
  readonly style: ViewStyle | undefined;
}

const styleElementId = 'ks-focus-ring';

/**
 * Web: one stylesheet draws the ring on `:focus-visible` only (keyboard focus, not pointer
 * clicks). Elements opt in through a `data-ks-focus` attribute naming the tone.
 */
function installStylesheet(): void {
  if (typeof document === 'undefined' || document.getElementById(styleElementId) !== null) return;
  const rules = (Object.keys(focusRing) as FocusTone[]).map((tone) => {
    const ring = focusRing[tone];
    return `[data-ks-focus="${tone}"]:focus-visible{outline:${ring.width}px solid ${ring.color};outline-offset:${ring.offset}px}`;
  });
  const element = document.createElement('style');
  element.id = styleElementId;
  element.textContent = `[data-ks-focus]:focus{outline:none}${rules.join('')}`;
  document.head.appendChild(element);
}

const noop = () => undefined;

export function useFocusRing(tone: FocusTone): FocusRing {
  installStylesheet();
  // React Native Web turns `dataSet` into `data-*` attributes; React Native's types do not know it.
  const props = { onFocus: noop, onBlur: noop, dataSet: { ksFocus: tone } };
  return { props, style: undefined };
}
