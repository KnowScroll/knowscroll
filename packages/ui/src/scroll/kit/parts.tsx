import type { ReactElement } from 'react';
import { Circle, Line, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { content, fontFamily, printed, scrollPage, status } from '@knowscroll/design-tokens';
import type { Point } from './earth-sky-scene';

/**
 * The parts every drawing kit shares in the V3 style (D-194): the palette, an arrow whose width means
 * something, the focus ring and the small mono label. Kits arrange these; they never decide a number.
 *
 * The palette by job. On a Scroll's page on the web the adaptive roles follow the page's appearance (D-424): INK is the
 * line and the label, PAPER and PAPER_DEEP are the plate's own colours. A body that must stay dark in both appearances
 * (a planet, a black hole, the night side) is SOLID, and what must stay light (a lit side) is LIT; never draw either with
 * INK or PAPER, which swap in the dark. SOLID is close to the dark plate, so a SOLID body on the plate carries an INK
 * edge; LIT is close to cream ink, so what crosses something LIT is SOLID or `edged`. The other colours carry a meaning
 * and keep one value.
 */

export const INK = content.ink;
export const PAPER = content.paper;
export const PAPER_DEEP = content.paper2;
export const SUN = content.continue;
export const BLUE = content.accent;
export const FOCUS = content.accentDeep;
export const WARM = status.danger.fill;
export const GREEN = content.fresh;
export const MUTED = content.muted;
export const SOLID = scrollPage.solid;
export const LIT = scrollPage.lit;
export const OUTLINE = 2.5;
/** The printed page's ground and sunken colours as plain hex, for colour maths only (see `mixColour`). */
export const PRINTED_PAPER = printed.paper;
export const PRINTED_PAPER_DEEP = printed.paper2;

/**
 * The glow round a star or a sun: its colour, translucent, over LIT. Translucent colour straight over a dark plate turns
 * olive; over LIT it stays light in both appearances. Draw it before what sits on it.
 */
export function Glow({
  at,
  radius,
  colour,
  opacity = 0.28,
}: {
  readonly at: Point;
  readonly radius: number;
  readonly colour: string;
  readonly opacity?: number;
}): ReactElement {
  return (
    <>
      <Circle cx={at.x} cy={at.y} r={radius} fill={LIT} />
      <Circle cx={at.x} cy={at.y} r={radius} fill={colour} opacity={opacity} />
    </>
  );
}

export function FocusRing({ at, radius }: { readonly at: Point; readonly radius: number }): ReactElement {
  return <Circle cx={at.x} cy={at.y} r={radius} fill="none" stroke={FOCUS} strokeWidth={3} strokeDasharray="5 4" />;
}

/** The focus ring for a part that is a stretch, not a point: the same dashed stroke as `FocusRing`, around a box. */
export function FocusBox({
  x,
  y,
  width,
  height,
}: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}): ReactElement {
  return (
    <Rect
      x={x}
      y={y}
      width={width}
      height={height}
      rx={6}
      fill="none"
      stroke={FOCUS}
      strokeWidth={3}
      strokeDasharray="5 4"
    />
  );
}

/** The same dashed stroke round a slanted band: the points of its outline in order. */
export function FocusOutline({ points }: { readonly points: readonly Point[] }): ReactElement {
  return (
    <Polygon
      points={points.map((point) => `${point.x},${point.y}`).join(' ')}
      fill="none"
      stroke={FOCUS}
      strokeWidth={3}
      strokeDasharray="5 4"
      strokeLinejoin="round"
    />
  );
}

export interface ArrowProps {
  readonly from: Point;
  readonly to: Point;
  /** Line width in pixels: in the kits it is proportional to the quantity the arrow stands for. */
  readonly width: number;
  readonly colour: string;
  readonly opacity?: number;
  /** An ink edge, for a pale arrow on the paper. */
  readonly outlined?: boolean;
  /**
   * A thin edge in the page's ground, outside everything else, for an arrow that crosses something light in both
   * appearances (a glow, a wash, a pale band): in Dark its cream ink would vanish there without it.
   */
  readonly edged?: boolean;
}

/** An arrow from one point to another with a head at the end, its head sized by its width. */
export function Arrow({
  from,
  to,
  width,
  colour,
  opacity = 1,
  outlined = false,
  edged = false,
}: ArrowProps): ReactElement {
  if (edged)
    return (
      <>
        <Arrow from={from} to={to} width={width + (outlined ? 3.5 : 0) + 3} colour={PAPER} opacity={opacity} />
        <Arrow from={from} to={to} width={width} colour={colour} opacity={opacity} outlined={outlined} />
      </>
    );
  if (outlined)
    return (
      <>
        <Arrow from={from} to={to} width={width + 3.5} colour={INK} opacity={opacity} />
        <Arrow from={from} to={to} width={width} colour={colour} opacity={opacity} />
      </>
    );
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length < 0.5) return <Line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={colour} strokeWidth={0} />;
  const direction = { x: (to.x - from.x) / length, y: (to.y - from.y) / length };
  const side = { x: -direction.y, y: direction.x };
  const headLength = Math.min(length * 0.6, 5 + width * 0.9);
  const headWidth = 3 + width * 0.95;
  const base = { x: to.x - direction.x * headLength, y: to.y - direction.y * headLength };
  return (
    <>
      <Line
        x1={from.x}
        y1={from.y}
        x2={base.x}
        y2={base.y}
        stroke={colour}
        strokeWidth={width}
        strokeLinecap="butt"
        opacity={opacity}
      />
      <Polygon
        points={`${to.x},${to.y} ${base.x + side.x * headWidth},${base.y + side.y * headWidth} ${base.x - side.x * headWidth},${base.y - side.y * headWidth}`}
        fill={colour}
        opacity={opacity}
      />
    </>
  );
}

/** A small mono label; decoration, hidden from assistive technology with the rest of the drawing. */
export function Label({
  at,
  text,
  bold = false,
  anchor = 'middle',
  edged = false,
}: {
  readonly at: Point;
  readonly text: string;
  readonly bold?: boolean;
  readonly anchor?: 'start' | 'middle' | 'end';
  /**
   * A halo in the page's ground under the words, for a label that can lie on a glow, which is light in both appearances:
   * in Dark its cream words would fade there without it.
   */
  readonly edged?: boolean;
}): ReactElement {
  const words = (
    <SvgText
      x={at.x}
      y={at.y}
      fontSize={8.5}
      fontFamily={fontFamily.mono}
      fill={bold ? INK : MUTED}
      textAnchor={anchor}
    >
      {text}
    </SvgText>
  );
  if (!edged) return words;
  return (
    <>
      <SvgText
        x={at.x}
        y={at.y}
        fontSize={8.5}
        fontFamily={fontFamily.mono}
        fill={PAPER}
        stroke={PAPER}
        strokeWidth={3}
        strokeLinejoin="round"
        textAnchor={anchor}
      >
        {text}
      </SvgText>
      {words}
    </>
  );
}

/**
 * A colour part of the way from one hex colour to another. Both must be concrete hex values: on the web an adaptive role
 * is a `var(...)` string, and mixing one gives an invalid colour (the browser draws black). Mix `printed` or fixed
 * colours (`PRINTED_PAPER`), never INK, PAPER, PAPER_DEEP, MUTED, FOCUS, SOLID or LIT.
 */
export function mixColour(from: string, to: string, share: number): string {
  const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);
  const blended = [1, 3, 5].map((at) => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * share));
  return `#${blended.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
