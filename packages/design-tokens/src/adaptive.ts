import { appearancePalettes, type AppearanceRole } from './appearance';
import { scrollPagePalettes, type ScrollPageRole } from './scroll-page-palette';

/**
 * Native (and Node tests): an adaptive role holds its Light value. React Native styles are plain
 * values fixed when a module loads, so native chrome is drawn Light; Talk still follows Appearance
 * through `TalkThemeProvider`. The web build resolves `adaptive.web.ts` instead.
 */
export function adaptive(role: AppearanceRole): string {
  return appearancePalettes.light[role];
}

/** A Scroll's page role (D-424): its Light value, for the same reason. */
export function pageAdaptive(role: ScrollPageRole): string {
  return scrollPagePalettes.light[role];
}
