import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Rect } from 'react-native-svg';
import { onCircle, SCENE_HEIGHT, SCENE_WIDTH } from './earth-sky-scene';
import { ARROW_PX_PER_SUNLIGHT, type GreenhouseScene } from './greenhouse-scene';
import { Arrow, FOCUS, GREEN, INK, Label, mixColour, OUTLINE, PAPER_DEEP, SKY_LIGHT, SUN, WARM } from './parts';

/**
 * The greenhouse kit drawn in the V3 style (D-194): the Sun, sunlight and what is reflected, the ground, one
 * layer of gas, the infrared the ground and the layer send out, and two bars and a thermometer for the
 * energy. The width of every arrow and the height of every bar is the energy it stands for, taken from the
 * scene (`greenhouse-scene.ts`); this file decides nothing about the physics. Labels are decoration, hidden
 * from assistive technology; the picture's accessible name is its description, set by the caller.
 */

const GROUND_TOP = 164;
/** The ground's colour: cool green where no layer has warmed it, warm orange where the thickest layer has. */
const COOL_GROUND = GREEN;
const MID_GROUND = '#F2D04C';
const WARM_GROUND = '#E8833A';

/** Cool teal, through yellow, to orange as the ground warms. */
const groundColour = (warmth: number): string =>
  warmth < 0.5
    ? mixColour(COOL_GROUND, MID_GROUND, warmth * 2)
    : mixColour(MID_GROUND, WARM_GROUND, (warmth - 0.5) * 2);
const LAYER_TOP = 84;

const has = (scene: GreenhouseScene, part: GreenhouseScene['parts'][number]): boolean => scene.parts.includes(part);
const width = (energy: number): number => Math.max(0, energy * ARROW_PX_PER_SUNLIGHT);

function Ground({ scene }: { readonly scene: GreenhouseScene }) {
  return (
    <G>
      <Rect
        x={-4}
        y={GROUND_TOP}
        width={SCENE_WIDTH + 8}
        height={SCENE_HEIGHT - GROUND_TOP + 4}
        fill={groundColour(scene.warmth)}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      <Label at={{ x: 160, y: GROUND_TOP + 24 }} text="GROUND" bold />
      {scene.focus === 'surface' ? (
        <Rect
          x={4}
          y={GROUND_TOP - 4}
          width={SCENE_WIDTH - 8}
          height={SCENE_HEIGHT - GROUND_TOP}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
    </G>
  );
}

/** The layer of gas: a band across the picture, thicker and more opaque the more infrared it absorbs. */
function Layer({ scene }: { readonly scene: GreenhouseScene }) {
  if (!has(scene, 'layer')) return null;
  return (
    <G>
      <Rect
        x={-4}
        y={LAYER_TOP}
        width={SCENE_WIDTH + 8}
        height={scene.layerPx}
        fill={SKY_LIGHT}
        opacity={0.35 + scene.layerOpacity * 0.65}
        stroke={INK}
        strokeWidth={1.6}
        strokeDasharray="6 4"
      />
      <Label at={{ x: 300, y: LAYER_TOP - 6 }} text="LAYER" anchor="end" />
      {scene.focus === 'layer' ? (
        <Rect
          x={2}
          y={LAYER_TOP - 5}
          width={SCENE_WIDTH - 4}
          height={scene.layerPx + 10}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
    </G>
  );
}

function SunDisc({ focused }: { readonly focused: boolean }) {
  const at = { x: 40, y: 36 };
  return (
    <G>
      {Array.from({ length: 12 }, (_, index) => index * 30).map((degrees) => {
        const from = onCircle(at, 23, degrees);
        const to = onCircle(at, 29, degrees);
        return <Line key={degrees} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={INK} strokeWidth={2} />;
      })}
      <Circle cx={at.x} cy={at.y} r={20} fill={SUN} stroke={INK} strokeWidth={OUTLINE} />
      {focused ? (
        <Circle cx={at.x} cy={at.y} r={34} fill="none" stroke={FOCUS} strokeWidth={3} strokeDasharray="5 4" />
      ) : null}
    </G>
  );
}

/** Sunlight arrives, a share is reflected back to space and the rest warms the ground. */
function SunlightView({ scene }: { readonly scene: GreenhouseScene }) {
  const landing = { x: 150, y: GROUND_TOP - 2 };
  return (
    <G>
      <Layer scene={scene} />
      <SunDisc focused={scene.focus === 'sun'} />
      <Arrow from={{ x: 64, y: 54 }} to={landing} width={width(1)} colour={SUN} outlined />
      <Arrow from={landing} to={{ x: 236, y: 28 }} width={width(scene.reflected)} colour={SUN} outlined />
      {scene.focus === 'reflected' ? (
        <Circle cx={195} cy={95} r={26} fill="none" stroke={FOCUS} strokeWidth={3} strokeDasharray="5 4" />
      ) : null}
      <Label at={{ x: 272, y: 22 }} text="REFLECTED" />
      <Label at={{ x: 74, y: 112 }} text="SUNLIGHT" anchor="start" />
      <Ground scene={scene} />
    </G>
  );
}

/** The infrared of the ground and of the layer: what passes through, what the layer absorbs and sends up, and what it sends back down. */
function InfraredView({ scene }: { readonly scene: GreenhouseScene }) {
  const layered = has(scene, 'layer');
  const layerBottom = LAYER_TOP + scene.layerPx;
  const absorbedByLayer = scene.surfaceEmission - scene.passesThrough;
  return (
    <G>
      <Layer scene={scene} />
      <Arrow
        from={{ x: 34, y: 20 }}
        to={{ x: 34, y: GROUND_TOP - 2 }}
        width={width(scene.absorbed)}
        colour={SUN}
        outlined
      />
      <Label at={{ x: 34, y: 12 }} text="SUN IN" />
      <Arrow
        from={{ x: 104, y: GROUND_TOP - 2 }}
        to={{ x: 104, y: 18 }}
        width={width(scene.passesThrough)}
        colour={WARM}
      />
      {layered ? (
        <>
          <Arrow
            from={{ x: 154, y: GROUND_TOP - 2 }}
            to={{ x: 154, y: layerBottom + 2 }}
            width={width(absorbedByLayer)}
            colour={WARM}
          />
          <Arrow
            from={{ x: 214, y: LAYER_TOP - 2 }}
            to={{ x: 214, y: 18 }}
            width={width(scene.layerUp)}
            colour={WARM}
          />
          <Arrow
            from={{ x: 264, y: layerBottom + 2 }}
            to={{ x: 264, y: GROUND_TOP - 2 }}
            width={width(scene.backDown)}
            colour={WARM}
          />
        </>
      ) : null}
      <Label at={{ x: 300, y: 12 }} text="SPACE" anchor="end" />
      {scene.focus === 'to-space' ? (
        <Line x1={90} y1={9} x2={layered ? 230 : 120} y2={9} stroke={FOCUS} strokeWidth={4} strokeDasharray="5 4" />
      ) : null}
      {scene.focus === 'back-down' && layered ? (
        <Rect
          x={248}
          y={layerBottom}
          width={34}
          height={GROUND_TOP - layerBottom}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
      <Ground scene={scene} />
    </G>
  );
}

/** Two bars, energy taken up and energy leaving, a note of the layer above the ground and a thermometer for the ground. */
function BalanceView({ scene }: { readonly scene: GreenhouseScene }) {
  const base = 146;
  const tallest = 92;
  const inHeight = tallest;
  const outHeight = tallest * (scene.toSpace / scene.absorbed);
  const mercury = 12 + scene.warmth * 84;
  return (
    <G>
      <Line x1={24} y1={base} x2={300} y2={base} stroke={INK} strokeWidth={2} />
      <Rect x={44} y={base - inHeight} width={52} height={inHeight} fill={SUN} stroke={INK} strokeWidth={OUTLINE} />
      <Rect x={116} y={base - outHeight} width={52} height={outHeight} fill={WARM} stroke={INK} strokeWidth={OUTLINE} />
      {scene.imbalanced ? (
        <Rect
          x={116}
          y={base - inHeight}
          width={52}
          height={inHeight - outHeight}
          fill="none"
          stroke={INK}
          strokeWidth={1.8}
          strokeDasharray="5 4"
        />
      ) : null}
      <Label at={{ x: 70, y: base + 18 }} text="IN" bold />
      <Label at={{ x: 142, y: base + 18 }} text="OUT TO SPACE" bold />
      {scene.focus === 'sun' ? (
        <Rect
          x={38}
          y={base - inHeight - 6}
          width={64}
          height={inHeight + 10}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
      {scene.focus === 'to-space' ? (
        <Rect
          x={110}
          y={base - inHeight - 6}
          width={64}
          height={inHeight + 10}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
      <Rect
        x={196}
        y={base - 12}
        width={64}
        height={12}
        fill={groundColour(scene.warmth)}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      {has(scene, 'layer') ? (
        <Rect
          x={196}
          y={base - 12 - 16 - scene.layerPx * 0.8}
          width={64}
          height={scene.layerPx * 0.8}
          fill={SKY_LIGHT}
          opacity={0.35 + scene.layerOpacity * 0.65}
          stroke={INK}
          strokeWidth={1.6}
          strokeDasharray="6 4"
        />
      ) : null}
      {has(scene, 'layer') ? <Label at={{ x: 228, y: base - 12 - 16 - scene.layerPx * 0.8 - 5 }} text="LAYER" /> : null}
      <Label at={{ x: 228, y: base + 18 }} text="GROUND" />
      <Rect
        x={282}
        y={base - 106}
        width={14}
        height={106}
        rx={7}
        fill={PAPER_DEEP}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      <Rect x={286} y={base - mercury} width={6} height={mercury} fill={WARM} />
      <Circle cx={289} cy={base + 2} r={11} fill={WARM} stroke={INK} strokeWidth={OUTLINE} />
      {scene.focus === 'surface' ? (
        <Rect
          x={274}
          y={base - 114}
          width={30}
          height={142}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
      <Label at={{ x: 289, y: base + 34 }} text="WARMTH" />
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function GreenhousePicture({ scene }: { readonly scene: GreenhouseScene }): ReactElement {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {scene.view === 'sunlight' ? <SunlightView scene={scene} /> : null}
      {scene.view === 'infrared' ? <InfraredView scene={scene} /> : null}
      {scene.view === 'energy-balance' ? <BalanceView scene={scene} /> : null}
    </Svg>
  );
}
