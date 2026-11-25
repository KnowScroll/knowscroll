import type { ReactElement } from 'react';
import { Circle } from 'react-native-svg';
import { content, printed, scrollPage } from '@knowscroll/design-tokens';
import type { Point } from './earth-sky-scene';

/**
 * The parts every drawing kit shares in the V3 style (D-194): the palette and the focus ring. Kits arrange these; they never decide a number.
 *
 * The palette by job. On a Scroll's page on the web the adaptive roles follow the page's appearance (D-424): INK is the
 * line and the label, PAPER and PAPER_DEEP are the plate's own colours. A body that must stay dark in both appearances
 * (a planet, a black hole, the night side) is SOLID, and what must stay light (a lit side) is LIT; never draw either with
 * INK or PAPER, which swap in the dark. SOLID is close to the dark plate, so a SOLID body on the plate carries an INK
 * edge; LIT is close to cream ink, so what crosses something LIT is SOLID. The other colours carry a meaning
 * and keep one value.
 */

export const INK = content.ink;
export const PAPER_DEEP = content.paper2;
export const SUN = content.continue;
export const FOCUS = content.accentDeep;
export const SOLID = scrollPage.solid;
export const LIT = scrollPage.lit;
export const OUTLINE = 2.5;
/** The printed page's sunken colour as plain hex, for colour maths only (see `mixColour`). */
export const PRINTED_PAPER_DEEP = printed.paper2;

export function FocusRing({ at, radius }: { readonly at: Point; readonly radius: number }): ReactElement {
  return <Circle cx={at.x} cy={at.y} r={radius} fill="none" stroke={FOCUS} strokeWidth={3} strokeDasharray="5 4" />;
}

/**
 * A colour part of the way from one hex colour to another. Both must be concrete hex values: on the web an adaptive role
 * is a `var(...)` string, and mixing one gives an invalid colour (the browser draws black). Mix `printed` or fixed
 * colours (`PRINTED_PAPER`), never INK, PAPER, PAPER_DEEP, FOCUS, SOLID or LIT.
 */
export function mixColour(from: string, to: string, share: number): string {
  const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);
  const blended = [1, 3, 5].map((at) => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * share));
  return `#${blended.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
