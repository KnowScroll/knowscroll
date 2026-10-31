import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg';
import { content } from '@knowscroll/design-tokens';
import { onCircle, SCENE_HEIGHT, SCENE_WIDTH, type Point } from './earth-sky-scene';
import {
  Arrow,
  BLUE,
  ellipsePoints,
  FOCUS,
  FocusRing,
  INK,
  Label,
  MUTED,
  OUTLINE,
  PAPER_DEEP,
  PhaseGlyph,
  pathOf,
  SKY_LIGHT,
  SUN,
} from './parts';
import { bulgeTips, type TidesScene } from './tides-scene';

/**
 * The tides kit drawn in the V3 style (D-194): Earth wrapped in an ocean, the Moon, the Sun, arrows for
 * the Moon's pull and the bulges the two raise. It draws a scene it is given and decides nothing about the
 * physics (`tides-scene.ts`). Labels are decoration, hidden from assistive technology; the picture's
 * accessible name is its description, set by the caller.
 */

/** How tall the Moon's own bulge is drawn, in pixels: the picture exaggerates it, as the text version says. */
const BULGE_PX = 13;

const has = (scene: TidesScene, part: TidesScene['parts'][number]): boolean => scene.parts.includes(part);

/** The Earth and its ocean: a land disc inside water stretched along a line into two bulges. */
function Ocean({
  at,
  radius,
  height,
  axis,
  dashed = false,
}: {
  readonly at: Point;
  readonly radius: number;
  readonly height: number;
  readonly axis: number;
  readonly dashed?: boolean;
}) {
  // The bulges grow along the line and the water thins across it, so the ocean keeps its volume.
  const points = ellipsePoints(at, radius + height, radius - height / 2, axis);
  return dashed ? (
    <Path d={pathOf(points)} fill="none" stroke={BLUE} strokeWidth={1.6} strokeDasharray="4 3" />
  ) : (
    <Path d={pathOf(points)} fill={SKY_LIGHT} stroke={INK} strokeWidth={OUTLINE} />
  );
}

function EarthDisc({ at, radius }: { readonly at: Point; readonly radius: number }) {
  return (
    <G>
      <Circle cx={at.x} cy={at.y} r={radius} fill={BLUE} stroke={INK} strokeWidth={OUTLINE} />
      <Path
        d={`M ${at.x - radius * 0.5} ${at.y - radius * 0.2} q ${radius * 0.3} ${-radius * 0.5} ${radius * 0.6} ${-radius * 0.1} q ${radius * 0.15} ${radius * 0.5} ${-radius * 0.25} ${radius * 0.62} q ${-radius * 0.5} ${radius * 0.05} ${-radius * 0.35} ${-radius * 0.52} Z`}
        fill={content.fresh}
      />
    </G>
  );
}

function Moon({ at, radius, focused }: { readonly at: Point; readonly radius: number; readonly focused: boolean }) {
  return (
    <G>
      <Circle cx={at.x} cy={at.y} r={radius} fill={PAPER_DEEP} stroke={INK} strokeWidth={OUTLINE} />
      <Circle cx={at.x - radius * 0.3} cy={at.y - radius * 0.2} r={radius * 0.22} fill={MUTED} opacity={0.45} />
      {focused ? <FocusRing at={at} radius={radius + 9} /> : null}
    </G>
  );
}

/** The Moon seen from far to the right of Earth, its lit half toward the Sun at the far left: a half-dark disc. */
function PhasedMoon({
  at,
  radius,
  focused,
}: {
  readonly at: Point;
  readonly radius: number;
  readonly focused: boolean;
}) {
  return (
    <G>
      <Circle cx={at.x} cy={at.y} r={radius} fill={INK} stroke={INK} strokeWidth={OUTLINE} />
      <Path d={`M ${at.x} ${at.y - radius} A ${radius} ${radius} 0 0 0 ${at.x} ${at.y + radius} Z`} fill={PAPER_DEEP} />
      {focused ? <FocusRing at={at} radius={radius + 9} /> : null}
    </G>
  );
}

function Sun({ at, radius, focused }: { readonly at: Point; readonly radius: number; readonly focused: boolean }) {
  return (
    <G>
      {Array.from({ length: 12 }, (_, index) => index * 30).map((degrees) => {
        const from = onCircle(at, radius + 3, degrees);
        const to = onCircle(at, radius + 9, degrees);
        return <Line key={degrees} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={INK} strokeWidth={2} />;
      })}
      <Circle cx={at.x} cy={at.y} r={radius} fill={SUN} stroke={INK} strokeWidth={OUTLINE} />
      {focused ? <FocusRing at={at} radius={radius + 14} /> : null}
    </G>
  );
}

/**
 * The Moon's pull on the near side, the centre and the far side of Earth as three arrows of length in
 * proportion to it (the differences enlarged), and below the Moon what is left once the centre's pull is taken away.
 */
function PullView({ scene }: { readonly scene: TidesScene }) {
  const earth = { x: 100, y: 62 };
  const radius = 30;
  const unit = 56;
  const rows = [
    { name: 'NEAR', length: unit * scene.pullNear },
    { name: 'CENTRE', length: unit },
    { name: 'FAR', length: unit * scene.pullFar },
  ];
  const leftOver = 24;
  return (
    <G>
      <EarthDisc at={earth} radius={radius} />
      <Moon at={{ x: 280, y: 62 }} radius={13} focused={scene.focus === 'moon'} />
      <Arrow
        from={{ x: earth.x + radius + 4, y: earth.y }}
        to={{ x: earth.x + radius + 4 + leftOver * scene.differenceNear, y: earth.y }}
        width={4}
        colour={BLUE}
      />
      <Arrow
        from={{ x: earth.x - radius - 4, y: earth.y }}
        to={{ x: earth.x - radius - 4 - leftOver * scene.differenceFar, y: earth.y }}
        width={4}
        colour={BLUE}
      />
      {rows.map((row, index) => (
        <G key={row.name}>
          <Label at={{ x: 30, y: 129 + index * 20 }} text={row.name} anchor="start" />
          <Arrow
            from={{ x: 74, y: 126 + index * 20 }}
            to={{ x: 74 + row.length, y: 126 + index * 20 }}
            width={4}
            colour={INK}
          />
        </G>
      ))}
      <Label at={{ x: 30, y: 108 }} text="THE MOON'S PULL AT THREE PLACES" anchor="start" bold />
      <Label at={{ x: 30, y: 187 }} text="DIFFERENCES ENLARGED" anchor="start" />
      <Label at={{ x: 160, y: 20 }} text="LEFT OVER AFTER THE CENTRE'S PULL" />
    </G>
  );
}

/** Earth in an ocean stretched into two bulges along the line to the Moon. */
function BulgesView({ scene }: { readonly scene: TidesScene }) {
  const earth = { x: 120, y: 100 };
  const radius = 36;
  const height = BULGE_PX * scene.combinedHeight;
  const moon = { x: 270, y: 100 };
  const { near, far } = bulgeTips(scene, earth, radius + 10 + height);
  return (
    <G>
      <Ocean at={earth} radius={radius + 10} height={height} axis={0} />
      <EarthDisc at={earth} radius={radius} />
      <Moon at={moon} radius={14} focused={scene.focus === 'moon'} />
      {scene.focus === 'near-bulge' ? <FocusRing at={near} radius={13} /> : null}
      {scene.focus === 'far-bulge' ? <FocusRing at={far} radius={13} /> : null}
      <Label at={{ x: 300, y: 18 }} text="THE STRETCHING IS ENLARGED" anchor="end" />
    </G>
  );
}

/** The Sun, the Moon and Earth from above, with the Moon's bulges, the Sun's smaller ones and the tide they make together. */
function SunMoonView({ scene }: { readonly scene: TidesScene }) {
  const earth = { x: 178, y: 98 };
  const radius = 22;
  const sun = { x: 42, y: 98 };
  const orbit = 70;
  const moon = onCircle(earth, orbit, scene.moonDegrees);
  const water = radius + 12;
  const height = BULGE_PX * scene.combinedHeight;
  const lunar = BULGE_PX * scene.moonHeight;
  const solar = BULGE_PX * scene.sunHeight;
  const { near: tip, far: opposite } = bulgeTips(scene, earth, water + height);
  return (
    <G>
      <Sun at={sun} radius={20} focused={scene.focus === 'sun'} />
      <Circle cx={earth.x} cy={earth.y} r={orbit} fill="none" stroke={INK} strokeWidth={1.4} strokeDasharray="6 5" />
      <Ocean at={earth} radius={water} height={height} axis={scene.combinedAxis} />
      <Ocean at={earth} radius={water} height={lunar} axis={scene.moonDegrees} dashed />
      <Ocean at={earth} radius={water} height={solar} axis={scene.sunDegrees} dashed />
      <EarthDisc at={earth} radius={radius} />
      <PhasedMoon at={moon} radius={11} focused={scene.focus === 'moon'} />
      {scene.focus === 'near-bulge' ? <FocusRing at={tip} radius={12} /> : null}
      {scene.focus === 'far-bulge' ? <FocusRing at={opposite} radius={12} /> : null}
      <Label
        at={{ x: 300, y: 18 }}
        text={scene.kind === 'spring' ? 'ADD: SPRING TIDE' : 'PARTLY CANCEL: NEAP TIDE'}
        anchor="end"
        bold
      />
    </G>
  );
}

const PHASE_LABELS = ['NEW', 'FIRST Q.', 'FULL', 'LAST Q.'] as const;
const PHASE_LIT = ['none', 'right', 'all', 'left'] as const;

/** Four bars: the size of the tide at each of the Moon's four main phases, with the shown phase marked. */
function RangeView({ scene }: { readonly scene: TidesScene }) {
  const base = 150;
  const tallest = 104;
  return (
    <G>
      <Line x1={30} y1={base} x2={292} y2={base} stroke={INK} strokeWidth={2} />
      {scene.bars.map((share, index) => {
        const x = 56 + index * 66;
        const current = index === scene.current;
        return (
          <G key={PHASE_LABELS[index]}>
            <Rect
              x={x - 20}
              y={base - share * tallest}
              width={40}
              height={share * tallest}
              fill={current ? BLUE : PAPER_DEEP}
              stroke={INK}
              strokeWidth={OUTLINE}
            />
            <PhaseGlyph at={{ x, y: base + 22 }} radius={10} lit={PHASE_LIT[index] ?? 'none'} />
            <Label at={{ x, y: base + 45 }} text={PHASE_LABELS[index] ?? ''} bold={current} />
          </G>
        );
      })}
      {scene.focus === 'range' ? (
        <Rect
          x={28}
          y={base - tallest - 8}
          width={266}
          height={tallest + 12}
          fill="none"
          stroke={FOCUS}
          strokeWidth={3}
          strokeDasharray="5 4"
        />
      ) : null}
      <Label at={{ x: 30, y: 30 }} text="SIZE OF THE TIDE" anchor="start" />
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function TidesPicture({ scene }: { readonly scene: TidesScene }): ReactElement {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {has(scene, 'pull-arrows') ? <PullView scene={scene} /> : null}
      {scene.view === 'bulges' ? <BulgesView scene={scene} /> : null}
      {scene.view === 'sun-moon' ? <SunMoonView scene={scene} /> : null}
      {scene.view === 'range' ? <RangeView scene={scene} /> : null}
    </Svg>
  );
}
