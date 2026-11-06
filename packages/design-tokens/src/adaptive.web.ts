import { appearanceReference, type AppearanceRole } from './appearance';

/**
 * Web: an adaptive role is a CSS custom property with its Light value as the fallback, so every
 * style written with it (including module-level `StyleSheet.create`) repaints the moment the page
 * names another appearance, with no re-render. React Native Web passes `var(...)` colours through.
 */
export function adaptive(role: AppearanceRole): string {
  return appearanceReference(role);
}
