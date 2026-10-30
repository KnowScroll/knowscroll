import type { ReactElement } from 'react';
import Svg, { Circle, ClipPath, Defs, G, Line, Path, Polygon, Rect, Text as SvgText } from 'react-native-svg';
import { content, fontFamily, family, status } from '@knowscroll/design-tokens';
import {
  axisDirection,
  beamFootprint,
  CARDINAL_MONTHS,
  MONTH_ANGLE_DEGREES,
  onCircle,
  onEllipse,
  pinPoint,
  SCENE_HEIGHT,
  SCENE_WIDTH,
  type EarthSkyScene,
  type Point,
} from './earth-sky-scene';

/**
 * The "Earth & sky" kit drawn in the V3 style (D-133): thick ink outlines on flat colour, the Sun, a
 * blue Earth with its 23.4° axis, the orbit, Ray the sunbeam, a pin on each hemisphere and the Moon.
 * It draws a scene it is given and decides nothing about the physics (`earth-sky-scene.ts`).
 * Decoration (month names, the day and night shading) is hidden from assistive technology; the
 * picture's accessible name is its description, set by the caller.
 */

const INK = content.ink;
const SUN = content.continue;
const EARTH = content.accent;
const LAND = content.fresh;
const WARM = status.danger.fill;
const COOL = family.systems.base;
const NEUTRAL = content.paper2;
const FOCUS = content.accentDeep;
const OUTLINE = 2.5;

const mix = (cool: string, warm: string, share: number): string => {
  const channel = (hex: string, at: number): number => parseInt(hex.slice(at, at + 2), 16);
  const blended = [1, 3, 5].map((at) =>
    Math.round(channel(cool, at) + (channel(warm, at) - channel(cool, at)) * share),
  );
  return `#${blended.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
};

/** A pin's colour from its warmth: cool blue, a neutral cream, warm red. */
function pinColour(warmth: number): string {
  return warmth >= 0.5 ? mix(NEUTRAL, WARM, (warmth - 0.5) * 2) : mix(COOL, NEUTRAL, warmth * 2);
}

const has = (scene: EarthSkyScene, part: EarthSkyScene['parts'][number]): boolean => scene.parts.includes(part);

function FocusRing({ at, radius }: { readonly at: Point; readonly radius: number }): ReactElement {
  return <Circle cx={at.x} cy={at.y} r={radius} fill="none" stroke={FOCUS} strokeWidth={3} strokeDasharray="5 4" />;
}

function Sun({ at, radius, focused }: { readonly at: Point; readonly radius: number; readonly focused: boolean }) {
  const rays = Array.from({ length: 12 }, (_, index) => index * 30);
  return (
    <G>
      {rays.map((degrees) => {
        const from = onCircle(at, radius + 3, degrees);
        const to = onCircle(at, radius + 9, degrees);
        return <Line key={degrees} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={INK} strokeWidth={2} />;
      })}
      <Circle cx={at.x} cy={at.y} r={radius} fill={SUN} stroke={INK} strokeWidth={OUTLINE} />
      {focused ? <FocusRing at={at} radius={radius + 14} /> : null}
    </G>
  );
}

interface EarthProps {
  readonly scene: EarthSkyScene;
  readonly at: Point;
  readonly radius: number;
  /** The direction of the Sun from this Earth, degrees (anticlockwise from the right), for the night side. */
  readonly sunward: number;
  readonly clipId: string;
  readonly pins: boolean;
  readonly pale?: boolean;
  /** Where the pins sit when they are drawn on the Sun-facing face (side views); otherwise at the poles of the axis. */
  readonly pinsFaceSun?: boolean;
}

/** The night half is a dark half-disc on the side away from the Sun. */
function nightHalf(at: Point, radius: number, sunward: number): string {
  const start = onCircle(at, radius, sunward + 90);
  const end = onCircle(at, radius, sunward - 90);
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 0 ${end.x} ${end.y} Z`;
}

function Earth({ scene, at, radius, sunward, clipId, pins, pale = false, pinsFaceSun = false }: EarthProps) {
  const axis = axisDirection(scene.axisTurn);
  const reach = radius * 1.45;
  const north = { x: at.x + axis.x * reach, y: at.y + axis.y * reach };
  const south = { x: at.x - axis.x * reach, y: at.y - axis.y * reach };
  const northPin = pinsFaceSun
    ? pinPoint(at, radius, 'north', scene.northPinAway)
    : { x: at.x + axis.x * radius * 0.78, y: at.y + axis.y * radius * 0.78 };
  const southPin = pinsFaceSun
    ? pinPoint(at, radius, 'south', scene.southPinAway)
    : { x: at.x - axis.x * radius * 0.78, y: at.y - axis.y * radius * 0.78 };
  const showAxis = has(scene, 'axis');
  return (
    <G opacity={pale ? 0.38 : 1}>
      <Defs>
        <ClipPath id={clipId}>
          <Circle cx={at.x} cy={at.y} r={radius} />
        </ClipPath>
      </Defs>
      <Circle cx={at.x} cy={at.y} r={radius} fill={EARTH} />
      <G clipPath={`url(#${clipId})`}>
        <Path
          d={`M ${at.x - radius * 0.55} ${at.y - radius * 0.25} q ${radius * 0.3} ${-radius * 0.45} ${radius * 0.62} ${-radius * 0.1} q ${radius * 0.1} ${radius * 0.5} ${-radius * 0.25} ${radius * 0.62} q ${-radius * 0.5} ${radius * 0.05} ${-radius * 0.37} ${-radius * 0.52} Z`}
          fill={LAND}
        />
        <Path d={nightHalf(at, radius, sunward)} fill={INK} opacity={0.32} />
      </G>
      <Circle cx={at.x} cy={at.y} r={radius} fill="none" stroke={INK} strokeWidth={OUTLINE} />
      {showAxis ? (
        <G>
          <Line x1={south.x} y1={south.y} x2={north.x} y2={north.y} stroke={INK} strokeWidth={2.5} />
          <Circle cx={north.x} cy={north.y} r={2.6} fill={INK} />
        </G>
      ) : null}
      {pins && has(scene, 'pins') ? (
        <G>
          <Circle
            cx={northPin.x}
            cy={northPin.y}
            r={4.6}
            fill={pinColour(scene.northWarmth)}
            stroke={INK}
            strokeWidth={1.8}
          />
          <Circle
            cx={southPin.x}
            cy={southPin.y}
            r={4.6}
            fill={pinColour(scene.southWarmth)}
            stroke={INK}
            strokeWidth={1.8}
          />
        </G>
      ) : null}
    </G>
  );
}

/** Ray the sunbeam: a little yellow slab with a face, turned with the beam it rides. */
function Ray({ at, focused }: { readonly at: Point; readonly focused: boolean }) {
  return (
    <G>
      <Rect x={at.x - 6} y={at.y - 13} width={12} height={26} rx={3} fill={SUN} stroke={INK} strokeWidth={2} />
      <Circle cx={at.x - 2.2} cy={at.y - 5} r={1.2} fill={INK} />
      <Circle cx={at.x + 2.2} cy={at.y - 5} r={1.2} fill={INK} />
      <Path d={`M ${at.x - 2.6} ${at.y} q 2.6 3 5.2 0`} fill="none" stroke={INK} strokeWidth={1.2} />
      {focused ? <FocusRing at={at} radius={20} /> : null}
    </G>
  );
}

/** One parallel beam from the left to a pin, with the patch of ground it covers drawn on the surface. */
function Beam({
  centre,
  radius,
  pin,
  from,
  colour,
}: {
  readonly centre: Point;
  readonly radius: number;
  readonly pin: Point;
  readonly from: number;
  readonly colour: string;
}) {
  const { top, bottom } = beamFootprint(centre, radius, pin);
  return (
    <G>
      <Polygon
        points={`${from},${top.y} ${top.x},${top.y} ${bottom.x},${bottom.y} ${from},${bottom.y}`}
        fill={SUN}
        opacity={0.55}
      />
      <Line x1={from} y1={top.y} x2={top.x} y2={top.y} stroke={INK} strokeWidth={1.4} />
      <Line x1={from} y1={bottom.y} x2={bottom.x} y2={bottom.y} stroke={INK} strokeWidth={1.4} />
      <Line x1={top.x} y1={top.y} x2={bottom.x} y2={bottom.y} stroke={colour} strokeWidth={5} strokeLinecap="round" />
    </G>
  );
}

/** Two places so close that a pale Earth under the real one would only be clutter. */
function near(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 26;
}

/** Two angles name the same place on the circle. */
function sameAngle(a: number, b: number): boolean {
  const gap = Math.abs(a - b) % 360;
  return Math.min(gap, 360 - gap) < 1;
}

function MonthLabel({ at, text, bold }: { readonly at: Point; readonly text: string; readonly bold: boolean }) {
  return (
    <SvgText
      x={at.x}
      y={at.y}
      fontSize={8.5}
      fontFamily={fontFamily.mono}
      fill={bold ? INK : content.muted}
      textAnchor="middle"
    >
      {text}
    </SvgText>
  );
}

/** Orbit views, seen from above: the orbit, the Sun, four pale Earths and the Earth of the month. */
function OrbitView({ scene }: { readonly scene: EarthSkyScene }) {
  const centre = { x: SCENE_WIDTH / 2, y: SCENE_HEIGHT / 2 + 4 };
  const halfWidth = 112;
  const halfHeight = halfWidth * scene.orbitRatio * 0.78;
  const sun = { x: centre.x - scene.sunOffset * halfWidth, y: centre.y };
  const earth = onEllipse(centre, halfWidth, halfHeight, scene.earthAngle);
  const earthRadius = 15;
  const sunward = (Math.atan2(-(sun.y - earth.y), sun.x - earth.x) * 180) / Math.PI;
  const orbitFocused = scene.focus === 'orbit';
  return (
    <G>
      <Path
        d={`M ${centre.x - halfWidth} ${centre.y} a ${halfWidth} ${halfHeight} 0 1 0 ${2 * halfWidth} 0 a ${halfWidth} ${halfHeight} 0 1 0 ${-2 * halfWidth} 0`}
        fill="none"
        stroke={orbitFocused ? FOCUS : INK}
        strokeWidth={orbitFocused ? 3.2 : 1.6}
        strokeDasharray="6 5"
      />
      {CARDINAL_MONTHS.map((month) => {
        const place = onEllipse(centre, halfWidth, halfHeight, MONTH_ANGLE_DEGREES[month]);
        const label = onEllipse(centre, halfWidth + 22, halfHeight + 16, MONTH_ANGLE_DEGREES[month]);
        const lead = { x: label.x, y: label.y + 3 };
        return (
          <G key={month}>
            <MonthLabel at={lead} text={month.toUpperCase()} bold={false} />
            {sameAngle(MONTH_ANGLE_DEGREES[month], scene.earthAngle) || near(place, earth) ? null : (
              <Earth
                scene={scene}
                at={place}
                radius={earthRadius * 0.82}
                sunward={(Math.atan2(-(sun.y - place.y), sun.x - place.x) * 180) / Math.PI}
                clipId={`ks-earth-${month}`}
                pins={false}
                pale
              />
            )}
          </G>
        );
      })}
      <Sun at={sun} radius={20} focused={scene.focus === 'sun'} />
      <Earth scene={scene} at={earth} radius={earthRadius} sunward={sunward} clipId="ks-earth-now" pins />
      {scene.focus === 'earth' || scene.focus === 'axis' ? <FocusRing at={earth} radius={earthRadius + 14} /> : null}
    </G>
  );
}

/** The side views: the Sun on the left, Earth on the right, and a beam to each hemisphere's pin. */
function SideView({ scene }: { readonly scene: EarthSkyScene }) {
  const close = scene.view === 'earth-close';
  const radius = close ? 78 : 46;
  const earth = { x: close ? 196 : 236, y: SCENE_HEIGHT / 2 };
  const sun = { x: 48, y: SCENE_HEIGHT / 2 };
  const northPin = pinPoint(earth, radius, 'north', scene.northPinAway);
  const southPin = pinPoint(earth, radius, 'south', scene.southPinAway);
  const beamFrom = close ? 12 : 100;
  const rayAt = { x: beamFrom + (close ? 44 : 28), y: northPin.y };
  return (
    <G>
      {has(scene, 'sun') ? <Sun at={sun} radius={30} focused={scene.focus === 'sun'} /> : null}
      <Beam centre={earth} radius={radius} pin={southPin} from={beamFrom} colour={pinColour(scene.southWarmth)} />
      <Beam centre={earth} radius={radius} pin={northPin} from={beamFrom} colour={pinColour(scene.northWarmth)} />
      <Earth scene={scene} at={earth} radius={radius} sunward={180} clipId="ks-earth-side" pins pinsFaceSun />
      {has(scene, 'ray') ? <Ray at={rayAt} focused={scene.focus === 'ray'} /> : null}
      {scene.focus === 'earth' || scene.focus === 'axis' ? <FocusRing at={earth} radius={radius + 10} /> : null}
      {scene.focus === 'north-pin' ? <FocusRing at={northPin} radius={11} /> : null}
      {scene.focus === 'south-pin' ? <FocusRing at={southPin} radius={11} /> : null}
    </G>
  );
}

/** The Moon's orbit round Earth, with the Sun far at the left; the lit half of the Moon faces the Sun. */
function MoonView({ scene }: { readonly scene: EarthSkyScene }) {
  const earth = { x: 176, y: SCENE_HEIGHT / 2 };
  const sun = { x: 16, y: SCENE_HEIGHT / 2 };
  const orbitRadius = 66;
  const moon = onCircle(earth, orbitRadius, scene.moonAngle);
  const moonRadius = 11;
  return (
    <G>
      <Sun at={sun} radius={30} focused={scene.focus === 'sun'} />
      <Circle
        cx={earth.x}
        cy={earth.y}
        r={orbitRadius}
        fill="none"
        stroke={INK}
        strokeWidth={1.6}
        strokeDasharray="6 5"
      />
      <Earth scene={scene} at={earth} radius={24} sunward={180} clipId="ks-earth-moon" pins={false} />
      <Circle
        cx={moon.x}
        cy={moon.y}
        r={moonRadius}
        fill={scene.moonPhased ? INK : content.paper2}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      {scene.moonPhased ? (
        <Path
          d={`M ${moon.x} ${moon.y - moonRadius} A ${moonRadius} ${moonRadius} 0 0 0 ${moon.x} ${moon.y + moonRadius} Z`}
          fill={content.paper2}
        />
      ) : null}
      {scene.focus === 'moon' ? <FocusRing at={moon} radius={moonRadius + 9} /> : null}
      {scene.focus === 'earth' ? <FocusRing at={earth} radius={34} /> : null}
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function EarthSkyPicture({ scene }: { readonly scene: EarthSkyScene }): ReactElement {
  const orbit = scene.view === 'orbit' || scene.view === 'orbit-stretched';
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {orbit ? (
        <OrbitView scene={scene} />
      ) : scene.view === 'moon-orbit' ? (
        <MoonView scene={scene} />
      ) : (
        <SideView scene={scene} />
      )}
    </Svg>
  );
}
