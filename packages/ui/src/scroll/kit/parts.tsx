import type { ReactElement } from 'react';
import { Circle, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { content, fontFamily, family, status } from '@knowscroll/design-tokens';
import type { Point } from './earth-sky-scene';

/**
 * The parts every drawing kit shares in the V3 style (D-194): the palette, an arrow whose width means
 * something, the focus ring and the small mono label. Kits arrange these; they never decide a number.
 */

export const INK = content.ink;
export const PAPER = content.paper;
export const PAPER_DEEP = content.paper2;
export const SUN = content.continue;
export const BLUE = content.accent;
export const FOCUS = content.accentDeep;
export const WARM = status.danger.fill;
export const SKY_LIGHT = family.systems.pattern;
export const GREEN = content.fresh;
export const MUTED = content.muted;
export const OUTLINE = 2.5;

/** A closed or open path through points. */
export function pathOf(points: readonly Point[], close = true): string {
  return (
    points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ') + (close ? ' Z' : '')
  );
}

/** The outline of an ellipse turned by `degrees` (anticlockwise from the right, y down the screen), as a polygon of 48 points. */
export function ellipsePoints(centre: Point, halfLength: number, halfWidth: number, degrees: number): Point[] {
  const turn = (degrees * Math.PI) / 180;
  return Array.from({ length: 48 }, (_, index) => {
    const around = (index * 2 * Math.PI) / 48;
    const along = halfLength * Math.cos(around);
    const across = halfWidth * Math.sin(around);
    return {
      x: centre.x + along * Math.cos(turn) - across * Math.sin(turn),
      y: centre.y - (along * Math.sin(turn) + across * Math.cos(turn)),
    };
  });
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
}

/** An arrow from one point to another with a head at the end, its head sized by its width. */
export function Arrow({ from, to, width, colour, opacity = 1, outlined = false }: ArrowProps): ReactElement {
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
}: {
  readonly at: Point;
  readonly text: string;
  readonly bold?: boolean;
  readonly anchor?: 'start' | 'middle' | 'end';
}): ReactElement {
  return (
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
}

/** The Moon seen from Earth in a phase, as a disc with its lit part: new is dark, full is lit, the quarters are half. */
export function PhaseGlyph({
  at,
  radius,
  lit,
}: {
  readonly at: Point;
  readonly radius: number;
  readonly lit: 'none' | 'right' | 'left' | 'all';
}): ReactElement {
  return (
    <>
      <Circle cx={at.x} cy={at.y} r={radius} fill={lit === 'all' ? PAPER : INK} stroke={INK} strokeWidth={1.8} />
      {lit === 'right' || lit === 'left' ? (
        <Path
          d={`M ${at.x} ${at.y - radius} A ${radius} ${radius} 0 0 ${lit === 'right' ? 1 : 0} ${at.x} ${at.y + radius} Z`}
          fill={PAPER}
        />
      ) : null}
    </>
  );
}

/** A colour part of the way from one hex colour to another. */
export function mixColour(from: string, to: string, share: number): string {
  const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);
  const blended = [1, 3, 5].map((at) => Math.round(channel(from, at) + (channel(to, at) - channel(from, at)) * share));
  return `#${blended.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}
