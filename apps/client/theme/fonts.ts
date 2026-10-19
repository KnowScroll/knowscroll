import bricolageGrotesque from '../../../packages/design-tokens/fonts/BricolageGrotesque.ttf';
import dmMono from '../../../packages/design-tokens/fonts/DMMono.ttf';
import instrumentSans from '../../../packages/design-tokens/fonts/InstrumentSans.ttf';

/**
 * The three bundled families from `packages/design-tokens/fonts/` (OFL; each licence travels
 * with its file). The reader never requests Google Fonts.
 */
export const fontFamilies = {
  display: 'BricolageGrotesque',
  body: 'InstrumentSans',
  label: 'DMMono',
} as const;

/** Font assets keyed by family name, for `useFonts`. */
export const fontAssets: Record<(typeof fontFamilies)[keyof typeof fontFamilies], number> = {
  BricolageGrotesque: bricolageGrotesque,
  InstrumentSans: instrumentSans,
  DMMono: dmMono,
};

/** Interim colour values from the v2.1 export's token sheet until `packages/design-tokens` lands. */
export const colours = {
  paper: '#FFFBF0',
  ink: '#111111',
  inkSecondary: '#4A463D',
  cobalt: '#2C46E8',
} as const;
