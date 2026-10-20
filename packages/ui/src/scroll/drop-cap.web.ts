import { content, fontFamily } from '@knowscroll/design-tokens';
import type { Span } from '@knowscroll/scroll-model';
import type { DropCap } from './drop-cap';

const styleElementId = 'ks-drop-cap';

/** One stylesheet draws the drop cap of every editorial opening: the DOM text stays whole. */
function installStylesheet(): void {
  if (typeof document === 'undefined' || document.getElementById(styleElementId) !== null) return;
  const element = document.createElement('style');
  element.id = styleElementId;
  element.textContent =
    `[data-ks-drop-cap]::first-letter{float:left;font-family:${fontFamily.display},sans-serif;font-weight:800;` +
    `font-size:66px;line-height:54px;padding:4px 8px 0 0;color:${content.accent}}`;
  document.head.appendChild(element);
}

/** Web: a real drop cap through `::first-letter`. */
export function dropCapOf(spans: readonly Span[], enabled: boolean): DropCap {
  if (!enabled) return { spans, textProps: {} };
  installStylesheet();
  return { spans, textProps: { dataSet: { ksDropCap: 'true' } } };
}
