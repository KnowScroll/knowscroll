import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';
import { SCENE_HEIGHT, SCENE_WIDTH, type Point } from './earth-sky-scene';
import { BLUE, FOCUS, FocusRing, INK, Label, MUTED, OUTLINE, SUN } from './parts';
import { CURVE_HALF_SPAN, CURVE_SAMPLES, DIP_ENLARGEMENT, type TransitScene } from './transit-scene';

/**
 * The transit kit drawn in the V3 style (D-194): a star, a planet and the graph of the star's brightness as
 * the planet crosses in front. It draws a scene it is given and decides nothing about the physics
 * (`transit-scene.ts`): the planet's width, its place, the dip and the whole curve are derived there. The
 * dip is enlarged and the sizes illustrative, as the text version says. Labels are decoration, hidden from
 * assistive technology; the picture's accessible name is its description, set by the caller.
 */

const PLANET = INK;

/** The graph's frame: where the curve is drawn, and how the share of the light maps to pixels. */
interface Graph {
  readonly left: number;
  readonly right: number;
  /** The level of the unblocked star. */
  readonly level: number;
  /** Pixels for the whole of the star's light, with the dip enlarged. */
  readonly span: number;
}

const crossingGraph: Graph = { left: 36, right: 284, level: 124, span: 100 * DIP_ENLARGEMENT };
const compareGraph: Graph = { left: 36, right: 284, level: 72, span: 100 * DIP_ENLARGEMENT };

const xOf = (graph: Graph, separation: number): number =>
  graph.left + ((separation + CURVE_HALF_SPAN) / (2 * CURVE_HALF_SPAN)) * (graph.right - graph.left);
const yOf = (graph: Graph, brightness: number): number => graph.level + (1 - brightness) * graph.span;

function curvePath(graph: Graph, curve: readonly number[]): string {
  return curve
    .map((brightness, index) => {
      const separation = -CURVE_HALF_SPAN + (index * 2 * CURVE_HALF_SPAN) / (CURVE_SAMPLES - 1);
      return `${index === 0 ? 'M' : 'L'} ${xOf(graph, separation)} ${yOf(graph, brightness)}`;
    })
    .join(' ');
}

function Axes({ graph, bottom }: { readonly graph: Graph; readonly bottom: number }) {
  return (
    <G>
      <Line x1={graph.left} y1={graph.level - 14} x2={graph.left} y2={bottom} stroke={INK} strokeWidth={1.8} />
      <Line x1={graph.left} y1={bottom} x2={graph.right + 6} y2={bottom} stroke={INK} strokeWidth={1.8} />
      <Line
        x1={graph.left}
        y1={graph.level}
        x2={graph.right}
        y2={graph.level}
        stroke={MUTED}
        strokeWidth={1.2}
        strokeDasharray="4 4"
      />
      <Label at={{ x: graph.left + 4, y: graph.level - 18 }} text="LIGHT FROM THE STAR" anchor="start" />
      <Label at={{ x: graph.right, y: bottom + 12 }} text="TIME" anchor="end" />
    </G>
  );
}

/** The planet going round its star seen from above, with us far below; in front of the star it blocks some of its light. */
function OrbitView({ scene }: { readonly scene: TransitScene }) {
  const star = { x: 160, y: 84 };
  const orbit = 64;
  // Degrees from the line between us and the star: nothing is straight below the star, between us and it.
  const turn = (scene.orbitDegrees * Math.PI) / 180;
  const planetAt: Point = { x: star.x + orbit * Math.sin(turn), y: star.y + orbit * Math.cos(turn) };
  const radius = 4 + scene.widthShare * 48;
  return (
    <G>
      <Circle cx={star.x} cy={star.y} r={orbit} fill="none" stroke={INK} strokeWidth={1.4} strokeDasharray="6 5" />
      <Line x1={star.x} y1={star.y} x2={star.x} y2={176} stroke={SUN} strokeWidth={4} opacity={0.7} />
      <Circle cx={star.x} cy={star.y} r={18} fill={SUN} stroke={INK} strokeWidth={OUTLINE} />
      <Circle cx={planetAt.x} cy={planetAt.y} r={radius} fill={PLANET} stroke={INK} strokeWidth={1.4} />
      <Path
        d={`M ${star.x - 12} 188 Q ${star.x} 172 ${star.x + 12} 188 Z`}
        fill={BLUE}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      <Label at={{ x: star.x + 20, y: 189 }} text="US" anchor="start" bold />
      {scene.focus === 'star' ? <FocusRing at={star} radius={30} /> : null}
      {scene.focus === 'planet' ? <FocusRing at={planetAt} radius={radius + 10} /> : null}
    </G>
  );
}

/** The star's disc with the planet in front, and below it the graph of its brightness with a marker. */
function CrossingView({ scene }: { readonly scene: TransitScene }) {
  const star = { x: 160, y: 50 };
  const starRadius = 34;
  const planet = { x: star.x + scene.separation * starRadius, y: star.y };
  const planetRadius = starRadius * scene.widthShare;
  const marker = { x: xOf(crossingGraph, scene.separation), y: yOf(crossingGraph, scene.brightness) };
  return (
    <G>
      <Circle cx={star.x} cy={star.y} r={starRadius * 1.22} fill={SUN} opacity={0.3} />
      <Circle cx={star.x} cy={star.y} r={starRadius} fill={SUN} stroke={INK} strokeWidth={OUTLINE} />
      <Circle cx={planet.x} cy={planet.y} r={planetRadius} fill={PLANET} stroke={INK} strokeWidth={1.2} />
      <Axes graph={crossingGraph} bottom={186} />
      <Path
        d={curvePath(crossingGraph, scene.curve)}
        fill="none"
        stroke={INK}
        strokeWidth={2.6}
        strokeLinejoin="round"
      />
      <Circle cx={marker.x} cy={marker.y} r={5} fill={BLUE} stroke={INK} strokeWidth={1.8} />
      {scene.focus === 'star' ? <FocusRing at={star} radius={starRadius + 12} /> : null}
      {scene.focus === 'planet' ? <FocusRing at={planet} radius={planetRadius + 10} /> : null}
      {scene.focus === 'dip' ? (
        <Rect
          x={xOf(crossingGraph, -1.4)}
          y={crossingGraph.level - 8}
          width={xOf(crossingGraph, 1.4) - xOf(crossingGraph, -1.4)}
          height={yOf(crossingGraph, 1 - scene.widthShare * scene.widthShare) - crossingGraph.level + 16}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
    </G>
  );
}

/** The graphs of a small planet and a large one together, the large one's dip four times as deep. */
function CompareView({ scene }: { readonly scene: TransitScene }) {
  const lowest = yOf(compareGraph, Math.min(...scene.largeCurve));
  return (
    <G>
      <Axes graph={compareGraph} bottom={186} />
      <Path
        d={curvePath(compareGraph, scene.smallCurve)}
        fill="none"
        stroke={MUTED}
        strokeWidth={2.6}
        strokeLinejoin="round"
      />
      <Path
        d={curvePath(compareGraph, scene.largeCurve)}
        fill="none"
        stroke={BLUE}
        strokeWidth={2.6}
        strokeLinejoin="round"
      />
      <Circle cx={200} cy={150} r={scene.smallWidth * 36} fill={PLANET} />
      <Label at={{ x: 214, y: 154 }} text="SMALL PLANET" anchor="start" />
      <Circle cx={200} cy={170} r={scene.largeWidth * 36} fill={BLUE} stroke={INK} strokeWidth={1.2} />
      <Label at={{ x: 214, y: 174 }} text="LARGE PLANET" anchor="start" />
      {scene.focus === 'planet' ? (
        <Rect
          x={188}
          y={138}
          width={104}
          height={40}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
      {scene.focus === 'dip' ? (
        <Rect
          x={xOf(compareGraph, -1.4)}
          y={compareGraph.level - 8}
          width={xOf(compareGraph, 1.4) - xOf(compareGraph, -1.4)}
          height={lowest - compareGraph.level + 16}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function TransitPicture({ scene }: { readonly scene: TransitScene }): ReactElement {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {scene.view === 'orbit' ? <OrbitView scene={scene} /> : null}
      {scene.view === 'crossing' ? <CrossingView scene={scene} /> : null}
      {scene.view === 'compare' ? <CompareView scene={scene} /> : null}
    </Svg>
  );
}
