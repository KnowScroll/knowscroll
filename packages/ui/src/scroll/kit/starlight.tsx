import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Path, Polygon, Rect } from 'react-native-svg';
import { VISIBLE_NANOMETRES, wavelengthColour, ZONE_STARS, type StarKind } from '../model';
import { SCENE_HEIGHT, SCENE_WIDTH, type Point } from './earth-sky-scene';
import { FocusBox, FocusOutline } from './focus-box';
import { BLUE, FOCUS, FocusRing, GREEN, INK, Label, MUTED, OUTLINE, PAPER_DEEP, WARM } from './parts';
import {
  BARS,
  FRAME,
  HOTTEST_FIRST,
  PLOT,
  STRIP,
  stripX,
  ZONE_AXIS,
  zoneX,
  type StarlightScene,
} from './starlight-scene';

/**
 * The starlight kit drawn in the V3 style (D-204): five stars over the spectrum, one star beside a star like
 * the Sun, light thinning with distance, the chart of stars and the habitable zones of three stars. It draws
 * a scene it is given and decides nothing about the physics (`starlight-scene.ts`). Labels are decoration,
 * hidden from assistive technology; the picture's accessible name is its description, set by the caller.
 */

const NAMES: Readonly<Record<StarKind, string>> = {
  'white-dwarf': 'WHITE DWARF',
  bright: 'BRIGHTER',
  'sun-like': 'SUN-LIKE',
  'low-mass': 'LOW MASS',
  giant: 'RED GIANT',
};

const colourOf = (scene: StarlightScene, kind: StarKind): string =>
  scene.colours[HOTTEST_FIRST.indexOf(kind)] ?? '#FFFFFF';

/** A star's disc in its drawn colour, with a faint glow. */
function StarDisc({ at, radius, colour }: { readonly at: Point; readonly radius: number; readonly colour: string }) {
  return (
    <G>
      <Circle cx={at.x} cy={at.y} r={radius * 1.25} fill={colour} opacity={0.28} />
      <Circle cx={at.x} cy={at.y} r={radius} fill={colour} stroke={INK} strokeWidth={OUTLINE} />
    </G>
  );
}

/** Five stars, hottest first, over the spectrum with where each glows most strongly. */
function ColourView({ scene }: { readonly scene: StarlightScene }) {
  const marked = Math.round(scene.markedIndex);
  const nanometres = Array.from(
    { length: (VISIBLE_NANOMETRES.to - VISIBLE_NANOMETRES.from) / 10 },
    (_, step) => VISIBLE_NANOMETRES.from + step * 10,
  );
  const stripTop = 122;
  return (
    <G>
      {HOTTEST_FIRST.map((kind, index) => {
        const centre = { x: 32 + index * 64, y: 44 };
        return (
          <G key={kind}>
            <StarDisc at={centre} radius={20} colour={scene.colours[index] ?? '#FFFFFF'} />
            <Label at={{ x: centre.x, y: 84 }} text={NAMES[kind]} bold={index === marked} />
            {scene.focus === 'star' && index === marked ? <FocusRing at={centre} radius={29} /> : null}
          </G>
        );
      })}
      <Rect
        x={STRIP.left}
        y={stripTop}
        width={stripX(VISIBLE_NANOMETRES.from) - STRIP.left}
        height={16}
        fill={PAPER_DEEP}
      />
      <Rect
        x={stripX(VISIBLE_NANOMETRES.to)}
        y={stripTop}
        width={STRIP.right - stripX(VISIBLE_NANOMETRES.to)}
        height={16}
        fill={PAPER_DEEP}
      />
      {nanometres.map((start) => (
        <Rect
          key={start}
          x={stripX(start)}
          y={stripTop}
          width={stripX(start + 10) - stripX(start) + 0.6}
          height={16}
          fill={wavelengthColour(start + 5)}
        />
      ))}
      <Rect
        x={STRIP.left}
        y={stripTop}
        width={STRIP.right - STRIP.left}
        height={16}
        fill="none"
        stroke={INK}
        strokeWidth={1.8}
      />
      {scene.peakX.map((x, index) => {
        const lift = index % 2 === 0 ? 0 : 10;
        const size = index === marked ? 6.5 : 4.5;
        return (
          <Polygon
            key={HOTTEST_FIRST[index]}
            points={`${x - size},${stripTop - 11 - lift} ${x + size},${stripTop - 11 - lift} ${x},${stripTop - 1}`}
            fill={scene.colours[index]}
            stroke={INK}
            strokeWidth={index === marked ? 2.4 : 1.4}
            strokeLinejoin="round"
          />
        );
      })}
      <Label at={{ x: stripX(265), y: 152 }} text="ULTRAVIOLET" />
      <Label at={{ x: stripX(565), y: 152 }} text="VISIBLE" />
      <Label at={{ x: stripX(800), y: 152 }} text="INFRARED" />
      <Label at={{ x: STRIP.left, y: 172 }} text="WHERE EACH STAR SHINES MOST STRONGLY" anchor="start" bold />
      <Label at={{ x: STRIP.left, y: 186 }} text="COLOURS STRENGTHENED · SIZES NOT TO SCALE" anchor="start" />
      {scene.focus === 'spectrum' ? (
        <FocusBox x={STRIP.left - 5} y={stripTop - 25} width={STRIP.right - STRIP.left + 10} height={48} />
      ) : null}
    </G>
  );
}

const BAR_ROWS = [
  { label: 'SIZE: SURFACE AREA', top: 110, colour: MUTED, focus: 'size' },
  { label: 'HEAT: LIGHT FROM EACH PATCH', top: 134, colour: WARM, focus: 'heat' },
  { label: 'TOTAL OUTPUT: THE TWO TOGETHER', top: 158, colour: FOCUS, focus: 'output' },
] as const;

/** One star beside a star like the Sun, and three bars on a stretched scale. */
function OutputView({ scene }: { readonly scene: StarlightScene }) {
  const marked = Math.round(scene.markedIndex);
  const values = { size: scene.sizeDex, heat: scene.heatDex, output: scene.outputDex };
  const markedAt = { x: 96, y: 48 };
  return (
    <G>
      <StarDisc at={markedAt} radius={scene.markedRadiusPx} colour={scene.colours[marked] ?? '#FFFFFF'} />
      <Label at={{ x: markedAt.x, y: 99 }} text={NAMES[HOTTEST_FIRST[marked] ?? 'sun-like']} bold />
      <Circle
        cx={240}
        cy={48}
        r={scene.referenceRadiusPx}
        fill="none"
        stroke={INK}
        strokeWidth={1.6}
        strokeDasharray="4 4"
      />
      <Label at={{ x: 240, y: 99 }} text="LIKE THE SUN" />
      <Line x1={BARS.middle} y1={104} x2={BARS.middle} y2={176} stroke={INK} strokeWidth={1.6} />
      {BAR_ROWS.map((row) => {
        const value = values[row.focus];
        const width = Math.abs(value) * BARS.pixelsPerDex;
        return (
          <G key={row.focus}>
            <Label at={{ x: 14, y: row.top + 8 }} text={row.label} anchor="start" bold={scene.focus === row.focus} />
            <Rect
              x={value >= 0 ? BARS.middle : BARS.middle - width}
              y={row.top}
              width={width}
              height={12}
              fill={row.colour}
              stroke={INK}
              strokeWidth={1.6}
            />
          </G>
        );
      })}
      {[-4, -3, -2, -1, 1, 2, 3, 4].map((step) => (
        <Line
          key={step}
          x1={BARS.middle + step * BARS.pixelsPerDex}
          y1={176}
          x2={BARS.middle + step * BARS.pixelsPerDex}
          y2={181}
          stroke={INK}
          strokeWidth={1.2}
        />
      ))}
      <Label at={{ x: 14, y: 192 }} text="EACH STEP ON THE BARS IS TEN TIMES · SIZES STRETCHED" anchor="start" />
      {scene.focus === 'star' ? <FocusRing at={markedAt} radius={scene.markedRadiusPx + 8} /> : null}
      {BAR_ROWS.map((row) =>
        scene.focus === row.focus ? <FocusBox key={row.focus} x={8} y={row.top - 4} width={296} height={20} /> : null,
      )}
    </G>
  );
}

const FRAME_NAMES = ['ONE STEP', 'TWO STEPS', 'FOUR STEPS'] as const;
const FRAME_STEPS = [1, 2, 4] as const;
const CENTRE_Y = 94;

/** A star and three square frames at growing distances, each cut into cells; one cell catches a smaller share the farther away it is. */
function DimmingView({ scene }: { readonly scene: StarlightScene }) {
  const star = { x: FRAME.star, y: CENTRE_Y };
  const marked = Math.round(scene.markedFrame);
  const far = FRAME_STEPS[2] * FRAME.cell;
  const farX = FRAME.star + FRAME.perStep * FRAME_STEPS[2];
  const sun = colourOf(scene, 'sun-like');
  return (
    <G>
      <Line
        x1={star.x}
        y1={star.y}
        x2={farX}
        y2={CENTRE_Y - far / 2}
        stroke={MUTED}
        strokeWidth={1.2}
        strokeDasharray="4 4"
      />
      <Line
        x1={star.x}
        y1={star.y}
        x2={farX}
        y2={CENTRE_Y + far / 2}
        stroke={MUTED}
        strokeWidth={1.2}
        strokeDasharray="4 4"
      />
      <StarDisc at={star} radius={14} colour={sun} />
      {FRAME_STEPS.map((steps, index) => {
        const side = steps * FRAME.cell;
        const left = FRAME.star + FRAME.perStep * steps - side / 2;
        const top = CENTRE_Y - side / 2;
        return (
          <G key={steps}>
            <Rect x={left} y={top} width={side} height={side} fill={PAPER_DEEP} opacity={0.6} />
            {Array.from({ length: steps - 1 }, (_, line) => (
              <G key={line}>
                <Line
                  x1={left + (line + 1) * FRAME.cell}
                  y1={top}
                  x2={left + (line + 1) * FRAME.cell}
                  y2={top + side}
                  stroke={MUTED}
                  strokeWidth={1}
                />
                <Line
                  x1={left}
                  y1={top + (line + 1) * FRAME.cell}
                  x2={left + side}
                  y2={top + (line + 1) * FRAME.cell}
                  stroke={MUTED}
                  strokeWidth={1}
                />
              </G>
            ))}
            <Rect x={left} y={top} width={FRAME.cell} height={FRAME.cell} fill={sun} stroke={INK} strokeWidth={1.4} />
            <Rect
              x={left}
              y={top}
              width={side}
              height={side}
              fill="none"
              stroke={INK}
              strokeWidth={index === marked ? 3 : 1.4}
            />
            <Label at={{ x: left + side / 2, y: 146 }} text={FRAME_NAMES[index] ?? ''} bold={index === marked} />
          </G>
        );
      })}
      <Label at={{ x: 20, y: 168 }} text="HOW BRIGHT IT LOOKS (NEAREST = FULL)" anchor="start" bold />
      <Rect x={20} y={174} width={200} height={10} fill={PAPER_DEEP} stroke={INK} strokeWidth={1.6} />
      <Rect x={20} y={174} width={200 * scene.share} height={10} fill={FOCUS} stroke={INK} strokeWidth={1.6} />
      {scene.focus === 'star' ? <FocusRing at={star} radius={24} /> : null}
      {scene.focus === 'spread' ? (
        <FocusBox x={FRAME.star + 38} y={CENTRE_Y - far / 2 - 6} width={farX - FRAME.star - 10} height={far + 12} />
      ) : null}
      {scene.focus === 'looks'
        ? (() => {
            const side = (FRAME_STEPS[marked] ?? 1) * FRAME.cell;
            const centreX = FRAME.star + FRAME.perStep * (FRAME_STEPS[marked] ?? 1);
            return (
              <FocusBox x={centreX - side / 2 - 5} y={CENTRE_Y - side / 2 - 5} width={side + 10} height={side + 10} />
            );
          })()
        : null}
    </G>
  );
}

/** The chart of stars: the main sequence as a band and the five stars as points. */
function DiagramView({ scene }: { readonly scene: StarlightScene }) {
  const marked = Math.round(scene.markedIndex);
  const band: Point[] = scene.bandX.map((x, index) => ({ x, y: scene.bandY[index] ?? 0 }));
  const outline: Point[] = [
    ...band.map((point) => ({ x: point.x, y: point.y - 16 })),
    ...[...band].reverse().map((point) => ({ x: point.x, y: point.y + 16 })),
  ];
  const at = (index: number): Point => ({ x: scene.pointX[index] ?? 0, y: scene.pointY[index] ?? 0 });
  const giant = at(HOTTEST_FIRST.indexOf('giant'));
  const dwarf = at(HOTTEST_FIRST.indexOf('white-dwarf'));
  return (
    <G>
      <Line x1={PLOT.left} y1={PLOT.top} x2={PLOT.left} y2={PLOT.bottom} stroke={INK} strokeWidth={1.8} />
      <Line x1={PLOT.left} y1={PLOT.bottom} x2={PLOT.right} y2={PLOT.bottom} stroke={INK} strokeWidth={1.8} />
      <Path
        d={band.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')}
        fill="none"
        stroke={MUTED}
        strokeWidth={14}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.3}
      />
      <Label at={{ x: PLOT.left + 60, y: PLOT.top + 40 }} text="MAIN SEQUENCE" anchor="start" />
      <Label at={{ x: giant.x, y: giant.y - 12 }} text="GIANTS" />
      <Label at={{ x: dwarf.x + 6, y: dwarf.y - 12 }} text="WHITE DWARFS" />
      {HOTTEST_FIRST.map((kind, index) => (
        <Circle
          key={kind}
          cx={scene.pointX[index]}
          cy={scene.pointY[index]}
          r={index === marked ? 8 : 5.5}
          fill={scene.colours[index]}
          stroke={INK}
          strokeWidth={index === marked ? 3 : 1.6}
        />
      ))}
      <Label at={{ x: PLOT.left + 4, y: 12 }} text="LIGHT GIVEN OUT ↑" anchor="start" />
      <Label at={{ x: (PLOT.left + PLOT.right) / 2, y: 174 }} text="HOTTER ← SURFACE TEMPERATURE → COOLER" />
      <Label at={{ x: (PLOT.left + PLOT.right) / 2, y: 190 }} text="BOTH SCALES STRETCHED" />
      {scene.focus === 'star' ? <FocusRing at={at(marked)} radius={15} /> : null}
      {scene.focus === 'main-sequence' ? <FocusOutline points={outline} /> : null}
    </G>
  );
}

const ROW_Y = [40, 84, 128] as const;
const ROW_NAMES = ['LOW-MASS STAR', 'SUN-LIKE STAR', 'BRIGHTER STAR'] as const;
const VERDICT_FILL: Readonly<Record<string, string>> = { 'too-hot': WARM, 'in-zone': GREEN, 'too-cold': BLUE };
const VERDICT_LABEL: Readonly<Record<string, string>> = {
  'too-hot': 'TOO HOT',
  'in-zone': 'IN THE ZONE',
  'too-cold': 'TOO COLD',
};

/** The habitable zones of three stars on a straight scale of distance, with a planet's orbit across them. */
function ZoneView({ scene }: { readonly scene: StarlightScene }) {
  const marked = Math.round(scene.zoneRow);
  const hasPlanet = scene.planetX >= 0;
  const labelLeft = scene.planetX > 215;
  return (
    <G>
      {ZONE_STARS.map((kind, row) => {
        const y = ROW_Y[row] ?? 0;
        const inner = scene.zoneInnerX[row] ?? 0;
        const outer = scene.zoneOuterX[row] ?? 0;
        const centre = { x: 36, y };
        return (
          <G key={kind}>
            <Line x1={ZONE_AXIS.left} y1={y} x2={ZONE_AXIS.right} y2={y} stroke={MUTED} strokeWidth={1} opacity={0.5} />
            <Rect
              x={inner}
              y={y - 12}
              width={Math.max(outer - inner, 1)}
              height={24}
              fill={GREEN}
              opacity={0.5}
              stroke={INK}
              strokeWidth={row === marked ? 3 : 1.6}
            />
            <StarDisc at={centre} radius={10} colour={scene.zoneColours[row] ?? '#FFFFFF'} />
            <Label at={{ x: 6, y: y + 25 }} text={ROW_NAMES[row] ?? ''} bold={row === marked} anchor="start" />
            {scene.focus === 'star' && row === marked ? <FocusRing at={centre} radius={17} /> : null}
            {scene.focus === 'zone' && row === marked ? (
              <FocusBox x={inner - 5} y={y - 17} width={outer - inner + 10} height={34} />
            ) : null}
            {hasPlanet ? (
              <G>
                <Circle
                  cx={scene.planetX}
                  cy={y}
                  r={5}
                  fill={VERDICT_FILL[scene.verdicts[row] ?? ''] ?? MUTED}
                  stroke={INK}
                  strokeWidth={1.8}
                />
                <Label
                  at={{ x: scene.planetX + (labelLeft ? -9 : 9), y: y + 3 }}
                  text={VERDICT_LABEL[scene.verdicts[row] ?? ''] ?? ''}
                  anchor={labelLeft ? 'end' : 'start'}
                  bold={row === marked}
                />
                {scene.focus === 'planet' && row === marked ? (
                  <FocusRing at={{ x: scene.planetX, y }} radius={11} />
                ) : null}
              </G>
            ) : null}
          </G>
        );
      })}
      {hasPlanet ? (
        <Line
          x1={scene.planetX}
          y1={16}
          x2={scene.planetX}
          y2={150}
          stroke={INK}
          strokeWidth={1.4}
          strokeDasharray="3 3"
        />
      ) : null}
      <Line x1={ZONE_AXIS.left} y1={156} x2={ZONE_AXIS.right} y2={156} stroke={INK} strokeWidth={1.8} />
      {Array.from({ length: ZONE_AXIS.maxAstronomicalUnits + 1 }, (_, units) => (
        <G key={units}>
          <Line x1={zoneX(units)} y1={156} x2={zoneX(units)} y2={161} stroke={INK} strokeWidth={1.4} />
          <Label at={{ x: zoneX(units), y: 172 }} text={String(units)} />
        </G>
      ))}
      <Label at={{ x: ZONE_AXIS.left, y: 190 }} text="DISTANCE FROM THE STAR · EARTH TO SUN = 1" anchor="start" />
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function StarlightPicture({ scene }: { readonly scene: StarlightScene }): ReactElement {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {scene.view === 'colour' ? <ColourView scene={scene} /> : null}
      {scene.view === 'output' ? <OutputView scene={scene} /> : null}
      {scene.view === 'dimming' ? <DimmingView scene={scene} /> : null}
      {scene.view === 'diagram' ? <DiagramView scene={scene} /> : null}
      {scene.view === 'zone' ? <ZoneView scene={scene} /> : null}
    </Svg>
  );
}
