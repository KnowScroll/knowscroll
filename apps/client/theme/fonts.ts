import type { FontFamilyDefinition } from 'expo-font';
import { fontFamily, fontWeightRange } from '@knowscroll/design-tokens';
import bricolageGrotesque from '@knowscroll/design-tokens/fonts/BricolageGrotesque.ttf';
import dmMono from '@knowscroll/design-tokens/fonts/DMMono.ttf';
import instrumentSans from '@knowscroll/design-tokens/fonts/InstrumentSans.ttf';

/**
 * The three bundled families from `packages/design-tokens/fonts/` (OFL; each licence travels with
 * its file). The reader never requests Google Fonts. Bricolage Grotesque and Instrument Sans are
 * variable fonts: the web gets their weight ranges as `@font-face` ranges, Android keeps the
 * whole `wght` axis, iOS reads it from the file, so `fontWeight` selects the instance.
 */
export const fontFamilies: FontFamilyDefinition[] = [
  { fontFamily: fontFamily.display, fontDefinitions: [{ path: bricolageGrotesque, weight: fontWeightRange.display }] },
  { fontFamily: fontFamily.text, fontDefinitions: [{ path: instrumentSans, weight: fontWeightRange.text }] },
  { fontFamily: fontFamily.mono, fontDefinitions: [{ path: dmMono, weight: fontWeightRange.mono }] },
];
