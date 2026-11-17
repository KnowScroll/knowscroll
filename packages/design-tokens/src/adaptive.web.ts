import { appearanceReference, type AppearanceRole } from './appearance';
import { scrollPagePalettes, scrollPageVariable, type ScrollPageRole } from './scroll-page-palette';

/**
 * Web: an adaptive role is a CSS custom property with its Light value as the fallback, so every
 * style written with it (including module-level `StyleSheet.create`) repaints the moment the page
 * names another appearance, with no re-render. React Native Web passes `var(...)` colours through.
 */
export function adaptive(role: AppearanceRole): string {
  return appearanceReference(role);
}

/** A Scroll's page role (D-424) as a custom property: inside a page it is the page's, outside it the Light fallback. */
export function pageAdaptive(role: ScrollPageRole): string {
  return `var(${scrollPageVariable(role)}, ${scrollPagePalettes.light[role]})`;
}
