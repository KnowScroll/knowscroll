import type { ViewStyle } from 'react-native';
import { focusHalo, focusRing, type FocusTone } from '@knowscroll/design-tokens';
import { useFocusHalo } from './focus-halo';

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
  // The halo is for the cobalt ring only: a band either side of it, so it is seen on a ground cobalt alone is lost on.
  const spread = focusRing.onLight.offset + focusRing.onLight.width + focusHalo.extra;
  const halos = (['light', 'dark'] as const).map(
    (halo) =>
      `[data-ks-focus="onLight"][data-ks-halo="${halo}"]:focus-visible{box-shadow:0 0 0 ${spread}px ${focusHalo[halo]}}`,
  );
  element.textContent = `[data-ks-focus]:focus{outline:none}${rules.join('')}${halos.join('')}`;
  document.head.appendChild(element);
}

const noop = () => undefined;

export function useFocusRing(tone: FocusTone): FocusRing {
  installStylesheet();
  // React Native Web turns `dataSet` into `data-*` attributes; React Native's types do not know it.
  const halo = useFocusHalo();
  const props = {
    onFocus: noop,
    onBlur: noop,
    dataSet: { ksFocus: tone, ...(tone === 'onLight' && halo !== undefined ? { ksHalo: halo } : {}) },
  };
  return { props, style: undefined };
}
