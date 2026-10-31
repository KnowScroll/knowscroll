import { content, space } from '@knowscroll/design-tokens';
import { useTalkTheme } from '@knowscroll/ui';

/**
 * The Talk list's colours, from the Talk theme in force (D-154): on the dark sky its text is cream and its
 * rows are drawn on the sky, and on Paper it keeps the v2.1 look. The rows are the same either way.
 */
export function useTalkListLook() {
  const dark = useTalkTheme().name === 'sky';
  return {
    dark,
    /** The `tone` a frame, a state block or the navigation takes. */
    tone: dark ? ('space' as const) : ('paper' as const),
    text: dark ? space.label : content.ink,
    quiet: dark ? space.label2 : content.ink2,
    rule: dark ? 'rgba(255,253,242,0.16)' : content.rule,
    /** A kind's tile: paper on the sky, ink on paper, with the glyph the other way round. */
    tile: dark ? content.paper : content.ink,
    tileGlyph: dark ? content.ink : content.paper,
    /** Behind the row that is open or pressed. */
    tint: dark ? 'rgba(255,253,242,0.1)' : content.highlight,
  };
}
