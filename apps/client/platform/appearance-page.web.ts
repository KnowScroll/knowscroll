import {
  appearanceAttribute,
  appearanceStyleSheet,
  scrollPageStyleSheet,
  type Appearance,
} from '@knowscroll/design-tokens';

const SHEET_ID = 'ks-appearance';

/**
 * Web: names the person's appearance on the page's root and installs, once, the style sheet that
 * gives every adaptive colour role its value for each appearance (#666). Every style already
 * written with `content.*` holds a `var(--ks-…)` reference, so this one attribute repaints the
 * whole app at once without a re-render: reading position, playback and open sheets are untouched.
 */
export function paintAppearance(appearance: Appearance): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SHEET_ID) === null) {
    const sheet = document.createElement('style');
    sheet.id = SHEET_ID;
    // A Scroll's page has its own palette in each appearance (D-424); its rules follow the app's.
    sheet.textContent = `${appearanceStyleSheet()}\n${scrollPageStyleSheet()}`;
    document.head.appendChild(sheet);
  }
  document.documentElement.setAttribute(appearanceAttribute, appearance);
}
