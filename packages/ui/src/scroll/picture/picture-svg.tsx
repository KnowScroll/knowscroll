import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Path, Polygon, Rect, Text as SvgText, TSpan } from 'react-native-svg';
import { fontFamily } from '@knowscroll/design-tokens';
import { colourOf, type PictureColours } from './palette';
import { RECEDED, RECEDED_TEXT } from './layout/common';
import type { ArcShape, LineShape, PictureRole, PictureScene, PictureShape } from './scene';

const FAMILIES = { sans: fontFamily.text, mono: fontFamily.mono, serif: fontFamily.display } as const;

/** The least stroke a pulsed shape is drawn with, so a shape that has no stroke of its own still shows the pulse. */
const PULSE_STROKE = 2;
/** How much heavier a pulsed shape's own stroke is drawn. */
const PULSE_GROWTH = 1.8;

/**
 * The opacity a text is drawn at: its layout opacity bent so that {@link RECEDED} gives {@link RECEDED_TEXT}, with 0
 * still 0 and 1 still 1 (two straight pieces), so a text fading in still fades and a receded label stays readable.
 */
export function textOpacity(opacity: number): number {
  const clamped = Math.min(1, Math.max(0, opacity));
  if (clamped <= RECEDED) return (clamped / RECEDED) * RECEDED_TEXT;
  return RECEDED_TEXT + ((clamped - RECEDED) / (1 - RECEDED)) * (1 - RECEDED_TEXT);
}

/** How a shape is stroked: a pulsed one in the `mark` colour and at least {@link PULSE_STROKE} wide. */
function strokeOf(
  shape: { readonly stroke: PictureRole; readonly strokeWidth: number },
  colours: PictureColours,
  pulsed: boolean,
): { stroke: string; strokeWidth: number } {
  if (!pulsed) return { stroke: colourOf(colours, shape.stroke), strokeWidth: shape.strokeWidth };
  return { stroke: colours.mark, strokeWidth: Math.max(PULSE_STROKE, shape.strokeWidth * PULSE_GROWTH) };
}

/** The size of an arrowhead for a stroke of this width. */
const headLength = (strokeWidth: number): number => 4 + strokeWidth * 2.5;

/** A filled arrowhead at `tip`, pointing along the angle `towards` (radians). */
function arrowHead(tip: { x: number; y: number }, towards: number, length: number): string {
  const spread = 0.45;
  const back = (turn: number) => ({
    x: tip.x - length * Math.cos(towards + turn),
    y: tip.y - length * Math.sin(towards + turn),
  });
  const left = back(spread);
  const right = back(-spread);
  return `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`;
}

function lineElement(shape: LineShape, colours: PictureColours, pulsed: boolean): ReactElement {
  const { stroke, strokeWidth } = strokeOf(shape, colours, pulsed);
  const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
  const head = headLength(strokeWidth);
  // The line stops at the back of its head, so a thick stroke never shows past the point.
  const endX = shape.arrow ? shape.x2 - Math.cos(angle) * head * 0.8 : shape.x2;
  const endY = shape.arrow ? shape.y2 - Math.sin(angle) * head * 0.8 : shape.y2;
  return (
    <>
      <Line
        x1={shape.x1}
        y1={shape.y1}
        x2={endX}
        y2={endY}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={shape.dashed ? '5 4' : undefined}
        strokeLinecap="round"
      />
      {shape.arrow ? <Polygon points={arrowHead({ x: shape.x2, y: shape.y2 }, angle, head)} fill={stroke} /> : null}
    </>
  );
}

function arcElement(shape: ArcShape, colours: PictureColours, pulsed: boolean): ReactElement {
  const { stroke, strokeWidth } = strokeOf(shape, colours, pulsed);
  const at = (angle: number) => ({ x: shape.cx + shape.r * Math.cos(angle), y: shape.cy + shape.r * Math.sin(angle) });
  const start = at(shape.from);
  const end = at(shape.to);
  const sweep = shape.to - shape.from;
  const large = Math.abs(sweep) > Math.PI ? 1 : 0;
  const clockwise = sweep >= 0 ? 1 : 0;
  // The tangent at the end of a clockwise arc points a quarter turn on from the radius.
  const tangent = shape.to + (sweep >= 0 ? Math.PI / 2 : -Math.PI / 2);
  return (
    <>
      <Path
        d={`M ${start.x} ${start.y} A ${shape.r} ${shape.r} 0 ${large} ${clockwise} ${end.x} ${end.y}`}
        stroke={stroke}
        strokeWidth={strokeWidth}
        fill="none"
        strokeLinecap="round"
      />
      {shape.arrow ? <Polygon points={arrowHead(end, tangent, headLength(shape.strokeWidth))} fill={stroke} /> : null}
    </>
  );
}

function shapeElement(shape: PictureShape, colours: PictureColours, pulsed: boolean): ReactElement {
  switch (shape.type) {
    case 'rect': {
      const stroke = strokeOf(shape, colours, pulsed);
      return (
        <Rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.cornerRadius}
          fill={colourOf(colours, shape.fill)}
          stroke={stroke.stroke}
          strokeWidth={stroke.strokeWidth}
        />
      );
    }
    case 'circle': {
      const stroke = strokeOf(shape, colours, pulsed);
      return (
        <Circle
          cx={shape.cx}
          cy={shape.cy}
          r={shape.r}
          fill={colourOf(colours, shape.fill)}
          stroke={stroke.stroke}
          strokeWidth={stroke.strokeWidth}
        />
      );
    }
    case 'line':
      return lineElement(shape, colours, pulsed);
    case 'arc':
      return arcElement(shape, colours, pulsed);
    case 'text':
      return (
        <SvgText
          x={shape.x}
          y={shape.y}
          fontSize={shape.size}
          fontFamily={FAMILIES[shape.family]}
          fontWeight={shape.weight === 'bold' ? '700' : '400'}
          fill={pulsed ? colours.mark : colourOf(colours, shape.fill)}
          textAnchor={shape.anchor}
        >
          {shape.lines.map((line, index) => (
            <TSpan key={index} x={shape.x} dy={index === 0 ? 0 : shape.lineHeight}>
              {line}
            </TSpan>
          ))}
        </SvgText>
      );
  }
}

export interface PictureSvgProps {
  readonly scene: PictureScene;
  readonly colours: PictureColours;
  /**
   * A part a linked phrase was just tapped for: each of its visible shapes is drawn at full strength in the `mark`
   * colour, as a stroke of at least 2 px (a shape with none gets one) and a text in the mark fill. A shape the picture
   * has not reached stays hidden.
   */
  readonly pulsing?: string | undefined;
}

/**
 * Draws a laid-out picture in its own pixels, filling the box it was laid out for. Decorative to assistive tech: the
 * frame around it carries the picture's words, so a screen reader hears them once.
 */
export function PictureSvg({ scene, colours, pulsing }: PictureSvgProps) {
  return (
    <Svg width={scene.width} height={scene.height} viewBox={`0 0 ${scene.width} ${scene.height}`} aria-hidden>
      {scene.shapes.map((shape) => {
        if (shape.opacity <= 0) return null;
        const pulsed = pulsing !== undefined && shape.part === pulsing;
        const opacity = pulsed ? 1 : shape.type === 'text' ? textOpacity(shape.opacity) : shape.opacity;
        return (
          <G key={shape.key} opacity={opacity}>
            {shapeElement(shape, colours, pulsed)}
          </G>
        );
      })}
    </Svg>
  );
}
