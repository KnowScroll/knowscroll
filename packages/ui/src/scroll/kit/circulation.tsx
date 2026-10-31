import type { ReactElement } from 'react';
import Svg, { Circle, Ellipse, G, Line, Path, Rect } from 'react-native-svg';
import { SCENE_HEIGHT, SCENE_WIDTH, type Point } from './earth-sky-scene';
import { CURVE_SAMPLES, type CirculationScene } from './circulation-scene';
import { Arrow, BLUE, FocusBox, FocusRing, INK, Label, MUTED, OUTLINE, PAPER, PAPER_DEEP, WARM } from './parts';

/**
 * The circulation kit drawn in the V3 style (D-201): the heart with its four chambers and valves, the two
 * loops, the pressure along the loop through the body and the curve of the oxygen haemoglobin holds. It draws
 * a scene it is given and decides nothing about the physiology (`circulation-scene.ts`): which valve is open,
 * how full a ventricle is, how much pressure each stretch uses up and how much oxygen is handed over are all
 * derived there. Red and blue are a drawing convention for blood rich and poor in oxygen, and the picture
 * says so. Labels are decoration, hidden from assistive technology; the picture's accessible name is its
 * description, set by the caller.
 */

const RICH = WARM;
const POOR = BLUE;

// ---------------------------------------------------------------------------------------------------------------
// The heart.

interface Chamber {
  readonly centre: Point;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly colour: string;
}

const RIGHT_ATRIUM: Chamber = { centre: { x: 70, y: 86 }, halfWidth: 30, halfHeight: 23, colour: POOR };
const LEFT_ATRIUM: Chamber = { centre: { x: 172, y: 86 }, halfWidth: 30, halfHeight: 23, colour: RICH };
const RIGHT_VENTRICLE: Chamber = { centre: { x: 82, y: 148 }, halfWidth: 30, halfHeight: 31, colour: POOR };
const LEFT_VENTRICLE: Chamber = { centre: { x: 150, y: 148 }, halfWidth: 35, halfHeight: 31, colour: RICH };

/** A chamber: its muscular wall, the blood in it as full as the scene says, and small arrows pressing in while it squeezes. */
function ChamberShape({
  chamber,
  fill,
  squeeze,
}: {
  readonly chamber: Chamber;
  readonly fill: number;
  readonly squeeze: number;
}) {
  const { centre, halfWidth, halfHeight, colour } = chamber;
  const scale = Math.sqrt(fill);
  const inward = squeeze > 0.5;
  return (
    <G>
      <Ellipse
        cx={centre.x}
        cy={centre.y}
        rx={halfWidth}
        ry={halfHeight}
        fill={PAPER}
        stroke={INK}
        strokeWidth={inward ? 6 : OUTLINE}
      />
      <Ellipse
        cx={centre.x}
        cy={centre.y}
        rx={(halfWidth - 6) * scale}
        ry={(halfHeight - 6) * scale}
        fill={colour}
        opacity={0.55}
      />
      {inward
        ? [0, 90, 180, 270].map((degrees) => {
            const turn = (degrees * Math.PI) / 180;
            const out = {
              x: centre.x + (halfWidth + 9) * Math.cos(turn),
              y: centre.y + (halfHeight + 9) * Math.sin(turn),
            };
            const near = {
              x: centre.x + (halfWidth + 1) * Math.cos(turn),
              y: centre.y + (halfHeight + 1) * Math.sin(turn),
            };
            return <Arrow key={degrees} from={out} to={near} width={2} colour={INK} />;
          })
        : null}
    </G>
  );
}

/**
 * A valve as two flaps hinged at its edges: they meet when it is shut and stand apart, pointing the way the
 * blood goes (`direction` is +1 for down the picture, -1 for up), when it is open.
 */
function Valve({
  at,
  half,
  open,
  direction,
}: {
  readonly at: Point;
  readonly half: number;
  readonly open: number;
  readonly direction: 1 | -1;
}) {
  const gap = 1.5 + (half - 4) * open;
  const reach = direction * 14 * open;
  return (
    <G>
      <Line
        x1={at.x - half}
        y1={at.y}
        x2={at.x - gap}
        y2={at.y + reach}
        stroke={INK}
        strokeWidth={4}
        strokeLinecap="round"
      />
      <Line
        x1={at.x + half}
        y1={at.y}
        x2={at.x + gap}
        y2={at.y + reach}
        stroke={INK}
        strokeWidth={4}
        strokeLinecap="round"
      />
      <Circle cx={at.x - half} cy={at.y} r={2.6} fill={INK} />
      <Circle cx={at.x + half} cy={at.y} r={2.6} fill={INK} />
    </G>
  );
}

/** Where the valves sit: between each atrium and its ventricle, and at the mouth of each artery. */
const AV_RIGHT: Point = { x: 74, y: 113 };
const AV_LEFT: Point = { x: 158, y: 113 };
const SL_PULMONARY: Point = { x: 100, y: 120 };
const SL_AORTIC: Point = { x: 126, y: 120 };

/** A bar of relative pressure: its label and a bar as long as the pressure, against the highest. */
function PressureBar({ y, label, level }: { readonly y: number; readonly label: string; readonly level: number }) {
  return (
    <G>
      <Label at={{ x: 232, y }} text={label} anchor="start" />
      <Rect x={232} y={y + 3} width={78} height={9} fill={PAPER_DEEP} stroke={INK} strokeWidth={1.2} />
      <Rect x={232} y={y + 3} width={78 * level} height={9} fill={INK} />
    </G>
  );
}

function HeartView({ scene }: { readonly scene: CirculationScene }) {
  const { focus } = scene;
  return (
    <G>
      <Path
        d="M 100 120 L 100 38 L 22 38"
        fill="none"
        stroke={POOR}
        strokeWidth={9}
        strokeLinejoin="round"
        opacity={0.6}
      />
      <Path
        d="M 126 120 L 126 20 L 306 20"
        fill="none"
        stroke={RICH}
        strokeWidth={9}
        strokeLinejoin="round"
        opacity={0.6}
      />
      <Arrow from={{ x: 4, y: 86 }} to={{ x: 38, y: 86 }} width={6} colour={POOR} outlined />
      <Arrow from={{ x: 232, y: 86 }} to={{ x: 206, y: 86 }} width={6} colour={RICH} outlined />
      <Label at={{ x: 2, y: 62 }} text="FROM BODY" anchor="start" />
      <Label at={{ x: 238, y: 74 }} text="FROM LUNGS" anchor="start" />
      <Label at={{ x: 22, y: 31 }} text="TO LUNGS" anchor="start" />
      <Label at={{ x: 306, y: 13 }} text="TO BODY" anchor="end" />
      <ChamberShape chamber={RIGHT_ATRIUM} fill={1} squeeze={scene.atriaSqueeze} />
      <ChamberShape chamber={LEFT_ATRIUM} fill={1} squeeze={scene.atriaSqueeze} />
      <ChamberShape chamber={RIGHT_VENTRICLE} fill={scene.ventricleFill} squeeze={scene.ventriclesSqueeze} />
      <ChamberShape chamber={LEFT_VENTRICLE} fill={scene.ventricleFill} squeeze={scene.ventriclesSqueeze} />
      <Valve at={AV_RIGHT} half={16} open={scene.atrioventricularOpen} direction={1} />
      <Valve at={AV_LEFT} half={16} open={scene.atrioventricularOpen} direction={1} />
      <Valve at={SL_PULMONARY} half={9} open={scene.semilunarOpen} direction={-1} />
      <Valve at={SL_AORTIC} half={9} open={scene.semilunarOpen} direction={-1} />
      {[AV_RIGHT, AV_LEFT].map((at) => (
        <Arrow
          key={at.x}
          from={{ x: at.x, y: at.y - 10 }}
          to={{ x: at.x, y: at.y + 26 }}
          width={4}
          colour={INK}
          opacity={scene.atrioventricularOpen * 0.8}
        />
      ))}
      {[SL_PULMONARY, SL_AORTIC].map((at) => (
        <Arrow
          key={at.x}
          from={{ x: at.x, y: at.y + 12 }}
          to={{ x: at.x, y: at.y - 28 }}
          width={4}
          colour={INK}
          opacity={scene.semilunarOpen * 0.8}
        />
      ))}
      <Label at={{ x: 82, y: 198 }} text="RIGHT" bold />
      <Label at={{ x: 150, y: 198 }} text="LEFT" bold />
      <Label at={{ x: 232, y: 106 }} text="RELATIVE PRESSURE" anchor="start" bold />
      <PressureBar y={116} label="LEFT ATRIUM" level={scene.atriumPressure} />
      <PressureBar y={138} label="LEFT VENTRICLE" level={scene.ventriclePressure} />
      <PressureBar y={160} label="AORTA" level={scene.arteryPressure} />
      {focus === 'atria' ? (
        <>
          <FocusRing at={RIGHT_ATRIUM.centre} radius={37} />
          <FocusRing at={LEFT_ATRIUM.centre} radius={37} />
        </>
      ) : null}
      {focus === 'ventricles' ? (
        <>
          <FocusRing at={RIGHT_VENTRICLE.centre} radius={40} />
          <FocusRing at={LEFT_VENTRICLE.centre} radius={43} />
        </>
      ) : null}
      {focus === 'valves' ? (
        <>
          <FocusRing at={{ x: AV_RIGHT.x, y: AV_RIGHT.y + 6 }} radius={22} />
          <FocusRing at={{ x: AV_LEFT.x, y: AV_LEFT.y + 6 }} radius={22} />
          <FocusRing at={{ x: 113, y: SL_PULMONARY.y - 6 }} radius={24} />
        </>
      ) : null}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The two loops.

function Swatch({ y, colour, text }: { readonly y: number; readonly colour: string; readonly text: string }) {
  return (
    <G>
      <Rect x={200} y={y - 8} width={11} height={11} fill={colour} opacity={0.7} stroke={INK} strokeWidth={1.4} />
      <Label at={{ x: 216, y }} text={text} anchor="start" />
    </G>
  );
}

function CircuitsView({ scene }: { readonly scene: CirculationScene }) {
  const { focus } = scene;
  return (
    <G>
      <Ellipse cx={110} cy={30} rx={62} ry={19} fill={PAPER_DEEP} stroke={INK} strokeWidth={OUTLINE} />
      <Label at={{ x: 110, y: 34 }} text="LUNGS" bold />
      <Ellipse cx={110} cy={170} rx={76} ry={19} fill={PAPER_DEEP} stroke={INK} strokeWidth={OUTLINE} />
      <Label at={{ x: 110, y: 174 }} text="REST OF THE BODY" bold />
      <Rect x={80} y={80} width={30} height={40} fill={POOR} opacity={0.55} stroke={INK} strokeWidth={OUTLINE} />
      <Rect x={110} y={80} width={30} height={40} fill={RICH} opacity={0.55} stroke={INK} strokeWidth={OUTLINE} />
      <Label at={{ x: 95, y: 104 }} text="RIGHT" bold />
      <Label at={{ x: 125, y: 104 }} text="LEFT" bold />
      <Arrow from={{ x: 92, y: 78 }} to={{ x: 62, y: 44 }} width={5} colour={POOR} outlined />
      <Arrow from={{ x: 158, y: 44 }} to={{ x: 128, y: 78 }} width={5} colour={RICH} outlined />
      <Arrow from={{ x: 128, y: 122 }} to={{ x: 158, y: 152 }} width={5} colour={RICH} outlined />
      <Arrow from={{ x: 62, y: 152 }} to={{ x: 92, y: 122 }} width={5} colour={POOR} outlined />
      <Label at={{ x: 200, y: 60 }} text="RIGHT: TO THE LUNGS" anchor="start" />
      <Label at={{ x: 200, y: 74 }} text="LEFT: TO THE BODY" anchor="start" />
      <Swatch y={104} colour={RICH} text="RICH IN OXYGEN" />
      <Swatch y={122} colour={POOR} text="POOR IN OXYGEN" />
      <Label at={{ x: 200, y: 142 }} text="A DRAWING CONVENTION:" anchor="start" />
      <Label at={{ x: 200, y: 154 }} text="BLOOD IS RED EITHER WAY" anchor="start" />
      {focus === 'right-side' ? <FocusBox x={74} y={74} width={42} height={52} /> : null}
      {focus === 'left-side' ? <FocusBox x={104} y={74} width={42} height={52} /> : null}
      {focus === 'lungs' ? <FocusBox x={40} y={8} width={140} height={46} /> : null}
      {focus === 'body' ? <FocusBox x={26} y={146} width={168} height={48} /> : null}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Pressure along the loop through the body.

const CHART = { left: 36, right: 300, top: 24, bottom: 128 } as const;
const SECTION_WIDTH = (CHART.right - CHART.left) / 4;
const SECTION_LABELS = ['ARTERIES', 'ARTERIOLES', 'CAPILLARIES', 'VEINS'] as const;
const FOCUS_SECTION = { arteries: 0, arterioles: 1, capillaries: 2, veins: 3 } as const;
const TUBES_Y = 168;

const xAtSection = (index: number): number => CHART.left + index * SECTION_WIDTH;
const yOfLevel = (level: number): number => CHART.bottom - level * (CHART.bottom - CHART.top);

function levelsPath(levels: readonly number[]): string {
  return levels.map((level, index) => `${index === 0 ? 'M' : 'L'} ${xAtSection(index)} ${yOfLevel(level)}`).join(' ');
}

function PressureView({ scene }: { readonly scene: CirculationScene }) {
  const changed = scene.levels.some((level, index) => Math.abs(level - (scene.usualLevels[index] ?? 0)) > 1e-9);
  const tube = (index: number, width: number) => (
    <Rect
      key={index}
      x={xAtSection(index) + 4}
      y={TUBES_Y - width / 2}
      width={SECTION_WIDTH - 8}
      height={width}
      rx={width / 2}
      fill={index < 2 ? RICH : POOR}
      opacity={0.6}
      stroke={INK}
      strokeWidth={1.6}
    />
  );
  const focusSection = scene.focus === 'none' ? undefined : FOCUS_SECTION[scene.focus as keyof typeof FOCUS_SECTION];
  return (
    <G>
      <Line x1={CHART.left} y1={CHART.top - 6} x2={CHART.left} y2={CHART.bottom} stroke={INK} strokeWidth={1.8} />
      <Line x1={CHART.left} y1={CHART.bottom} x2={CHART.right + 6} y2={CHART.bottom} stroke={INK} strokeWidth={1.8} />
      <Label at={{ x: CHART.left + 4, y: CHART.top - 10 }} text="AVERAGE PRESSURE (RELATIVE)" anchor="start" />
      {[1, 2, 3].map((index) => (
        <Line
          key={index}
          x1={xAtSection(index)}
          y1={CHART.top}
          x2={xAtSection(index)}
          y2={CHART.bottom}
          stroke={MUTED}
          strokeWidth={1}
          strokeDasharray="3 4"
        />
      ))}
      {changed ? (
        <Path
          d={levelsPath(scene.usualLevels)}
          fill="none"
          stroke={MUTED}
          strokeWidth={2}
          strokeDasharray="5 4"
          strokeLinejoin="round"
        />
      ) : null}
      <Path
        d={`${levelsPath(scene.levels)} L ${xAtSection(4)} ${CHART.bottom} L ${xAtSection(0)} ${CHART.bottom} Z`}
        fill={RICH}
        opacity={0.18}
      />
      <Path d={levelsPath(scene.levels)} fill="none" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      {SECTION_LABELS.map((label, index) => (
        <Label key={label} at={{ x: xAtSection(index) + SECTION_WIDTH / 2, y: CHART.bottom + 13 }} text={label} />
      ))}
      {tube(0, 18)}
      {tube(1, 18 * scene.arterioleWidth)}
      {tube(2, 18)}
      {tube(3, 18)}
      <Label at={{ x: CHART.left, y: 195 }} text="FLOW" anchor="start" />
      <Arrow
        from={{ x: CHART.left + 28, y: 192 }}
        to={{ x: CHART.left + 70, y: 192 }}
        width={1.5 + 3 * scene.flow}
        colour={INK}
      />
      {changed ? <Label at={{ x: 130, y: 195 }} text="DASHED LINE: THE USUAL" anchor="start" /> : null}
      {focusSection === undefined ? null : (
        <FocusBox
          x={xAtSection(focusSection) + 2}
          y={CHART.top - 2}
          width={SECTION_WIDTH - 4}
          height={TUBES_Y + 14 - (CHART.top - 2)}
        />
      )}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Oxygen on haemoglobin.

const PLOT = { left: 38, right: 176, top: 28, bottom: 150 } as const;
const xOfOxygen = (share: number): number => PLOT.left + share * (PLOT.right - PLOT.left);
const yOfLoaded = (loaded: number): number => PLOT.bottom - loaded * (PLOT.bottom - PLOT.top);

function curvePath(curve: readonly number[]): string {
  return curve
    .map((loaded, index) => `${index === 0 ? 'M' : 'L'} ${xOfOxygen(index / (CURVE_SAMPLES - 1))} ${yOfLoaded(loaded)}`)
    .join(' ');
}

const BAR = { width: 24, top: 40, bottom: 150 } as const;
const CARRIERS = { lungs: 206, here: 270 } as const;

/** A tall bar of haemoglobin, loaded with oxygen up to the given share. */
function Carrier({ x, loaded, label }: { readonly x: number; readonly loaded: number; readonly label: string }) {
  const height = BAR.bottom - BAR.top;
  return (
    <G>
      <Rect x={x} y={BAR.top} width={BAR.width} height={height} fill={PAPER_DEEP} stroke={INK} strokeWidth={OUTLINE} />
      <Rect
        x={x}
        y={BAR.bottom - height * loaded}
        width={BAR.width}
        height={height * loaded}
        fill={RICH}
        opacity={0.85}
      />
      <Label at={{ x: x + BAR.width / 2, y: BAR.bottom + 13 }} text={label} />
    </G>
  );
}

function OxygenView({ scene }: { readonly scene: CirculationScene }) {
  const lungs = { x: xOfOxygen(scene.lungsAt), y: yOfLoaded(scene.lungsLoaded) };
  const here = { x: xOfOxygen(scene.hereAt), y: yOfLoaded(scene.hereLoaded) };
  const tissue = scene.handedOver > 0.5;
  const gapTop = BAR.bottom - (BAR.bottom - BAR.top) * scene.lungsLoaded;
  const gapBottom = BAR.bottom - (BAR.bottom - BAR.top) * scene.hereLoaded;
  return (
    <G>
      <Line x1={PLOT.left} y1={PLOT.top - 6} x2={PLOT.left} y2={PLOT.bottom} stroke={INK} strokeWidth={1.8} />
      <Line x1={PLOT.left} y1={PLOT.bottom} x2={PLOT.right + 6} y2={PLOT.bottom} stroke={INK} strokeWidth={1.8} />
      <Label at={{ x: PLOT.left + 4, y: PLOT.top - 12 }} text="SHARE OF HAEMOGLOBIN LOADED" anchor="start" />
      <Label at={{ x: PLOT.left, y: PLOT.bottom + 13 }} text="OXYGEN AROUND: LOW TO HIGH" anchor="start" />
      <Path d={curvePath(scene.curve)} fill="none" stroke={INK} strokeWidth={3} strokeLinejoin="round" />
      <Line
        x1={lungs.x}
        y1={lungs.y}
        x2={lungs.x}
        y2={PLOT.bottom}
        stroke={MUTED}
        strokeWidth={1.2}
        strokeDasharray="4 4"
      />
      <Circle cx={lungs.x} cy={lungs.y} r={5} fill={RICH} stroke={INK} strokeWidth={1.8} />
      <Label at={{ x: lungs.x - 8, y: lungs.y - 7 }} text="LUNGS" anchor="end" />
      {tissue ? (
        <>
          <Line
            x1={here.x}
            y1={here.y}
            x2={here.x}
            y2={PLOT.bottom}
            stroke={MUTED}
            strokeWidth={1.2}
            strokeDasharray="4 4"
          />
          <Line
            x1={here.x}
            y1={here.y}
            x2={PLOT.left}
            y2={here.y}
            stroke={MUTED}
            strokeWidth={1.2}
            strokeDasharray="4 4"
          />
          <Circle cx={here.x} cy={here.y} r={5} fill={BLUE} stroke={INK} strokeWidth={1.8} />
          <Label at={{ x: here.x + 9, y: here.y + 14 }} text="TISSUE" anchor="start" />
        </>
      ) : null}
      <Carrier x={CARRIERS.lungs} loaded={scene.lungsLoaded} label="LUNGS" />
      {tissue ? (
        <>
          <Carrier x={CARRIERS.here} loaded={scene.hereLoaded} label="TISSUE" />
          <Arrow
            from={{ x: CARRIERS.lungs + BAR.width + 4, y: (gapTop + gapBottom) / 2 }}
            to={{ x: CARRIERS.here - 4, y: (gapTop + gapBottom) / 2 }}
            width={3}
            colour={INK}
          />
          <Label at={{ x: (CARRIERS.lungs + CARRIERS.here + BAR.width) / 2, y: BAR.top - 8 }} text="HANDED OVER" />
        </>
      ) : null}
      {scene.focus === 'curve' ? (
        <FocusBox
          x={PLOT.left - 6}
          y={PLOT.top - 4}
          width={PLOT.right - PLOT.left + 14}
          height={PLOT.bottom - PLOT.top + 4}
        />
      ) : null}
      {scene.focus === 'handoff' && tissue ? (
        <FocusBox
          x={CARRIERS.lungs - 8}
          y={BAR.top - 18}
          width={CARRIERS.here - CARRIERS.lungs + BAR.width + 16}
          height={BAR.bottom - BAR.top + 20}
        />
      ) : null}
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function CirculationPicture({ scene }: { readonly scene: CirculationScene }): ReactElement {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {scene.view === 'heart' ? <HeartView scene={scene} /> : null}
      {scene.view === 'circuits' ? <CircuitsView scene={scene} /> : null}
      {scene.view === 'pressure' ? <PressureView scene={scene} /> : null}
      {scene.view === 'oxygen' ? <OxygenView scene={scene} /> : null}
    </Svg>
  );
}
