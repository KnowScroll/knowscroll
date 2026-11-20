import type { PagePalette } from '../page/page-palette';
import type { PictureRole } from './scene';

/**
 * The colour of each picture role on a page. Page roles follow the page's appearance (on the web they are the page's
 * own custom properties, D-424). The meaning colours keep one value in both appearances and were chosen to reach 3:1
 * against the plate and the ground of both: warm #C75B12 (3.6:1 on the light plate, 3.9:1 on the dark) and cool #3F78D6
 * (3.7:1 and 3.8:1). `mark` is the page's link colour, so a linked phrase and the part it names match in either
 * appearance. Nothing here mixes colours: a receded part is drawn with the opacity its scene gives it.
 */
export const WARM = '#C75B12';
export const COOL = '#3F78D6';

export type PictureColours = Readonly<Record<Exclude<PictureRole, 'none'>, string>>;

export function pictureColours(page: PagePalette): PictureColours {
  return {
    ink: page.ink,
    ink2: page.ink2,
    rule: page.rule,
    ground: page.ground,
    raised: page.raised,
    warm: WARM,
    cool: COOL,
    mark: page.link,
  };
}

/** The colour a role is drawn in, or `none` for no paint. */
export function colourOf(colours: PictureColours, role: PictureRole): string {
  return role === 'none' ? 'none' : colours[role];
}
