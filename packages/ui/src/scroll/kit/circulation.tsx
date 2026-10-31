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

const RIGHT_ATRIUM: Chamber = { centre: { x: 74, y: 88 }, halfWidth: 28, halfHeight: 22, colour: POOR };
const LEFT_ATRIUM: Chamber = { centre: { x: 188, y: 88 }, halfWidth: 28, halfHeight: 22, colour: RICH };
const RIGHT_VENTRICLE: Chamber = { centre: { x: 98, y: 148 }, halfWidth: 34, halfHeight: 34, colour: POOR };
const LEFT_VENTRICLE: Chamber = { centre: { x: 158, y: 148 }, halfWidth: 38, halfHeight: 34, colour: RICH };

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

/** A valve as two flaps hinged at its edges: they meet when it is shut and stand apart, pointing the way the blood goes, when it is open. */
function Valve({ at, half, open }: { readonly at: Point; readonly half: number; readonly open: number }) {
  const gap = 2 + (half - 5) * open;
  const reach = 15 * open;
  return (
    <G>
      <Line
        x1={at.x - half}
        y1={at.y}
        x2={at.x - gap}
        y2={at.y + reach}
        stroke={INK}
        strokeWidth={3.2}
        strokeLinecap="round"
      />
      <Line
        x1={at.x + half}
        y1={at.y}
        x2={at.x + gap}
        y2={at.y + reach}
        stroke={INK}
        strokeWidth={3.2}
        strokeLinecap="round"
      />
    </G>
  );
}

const AV_RIGHT: Point = { x: 80, y: 112 };
const AV_LEFT: Point = { x: 178, y: 112 };
const SL_PULMONARY: Point = { x: 118, y: 118 };
const SL_AORTIC: Point = { x: 142, y: 118 };

/** A bar of relative pressure: its label and a bar as long as the pressure, against the highest. */
function PressureBar({ y, label, level }: { readonly y: number; readonly label: string; readonly level: number }) {
  return (
    <G>
      <Label at={{ x: 228, y }} text={label} anchor="start" />
      <Rect x={228} y={y + 3} width={80} height={9} fill={PAPER_DEEP} stroke={INK} strokeWidth={1.2} />
      <Rect x={228} y={y + 3} width={80 * level} height={9} fill={INK} />
    </G>
  );
}

function HeartView({ scene }: { readonly scene: CirculationScene }) {
  const { focus } = scene;
  return (
    <G>
      <Path
        d="M 118 114 L 118 34 L 30 34"
        fill="none"
        stroke={POOR}
        strokeWidth={9}
        strokeLinejoin="round"
        opacity={0.6}
      />
      <Path
        d="M 142 114 L 142 18 L 306 18"
        fill="none"
        stroke={RICH}
        strokeWidth={9}
        strokeLinejoin="round"
        opacity={0.6}
      />
      <Arrow from={{ x: 8, y: 88 }} to={{ x: 44, y: 88 }} width={6} colour={POOR} outlined />
      <Arrow from={{ x: 312, y: 88 }} to={{ x: 220, y: 88 }} width={6} colour={RICH} outlined />
      <Label at={{ x: 6, y: 78 }} text="FROM BODY" anchor="start" />
      <Label at={{ x: 314, y: 78 }} text="FROM LUNGS" anchor="end" />
      <Label at={{ x: 30, y: 28 }} text="TO LUNGS" anchor="start" />
      <Label at={{ x: 306, y: 12 }} text="TO BODY" anchor="end" />
      <ChamberShape chamber={RIGHT_ATRIUM} fill={1} squeeze={scene.atriaSqueeze} />
      <ChamberShape chamber={LEFT_ATRIUM} fill={1} squeeze={scene.atriaSqueeze} />
      <ChamberShape chamber={RIGHT_VENTRICLE} fill={scene.ventricleFill} squeeze={scene.ventriclesSqueeze} />
      <ChamberShape chamber={LEFT_VENTRICLE} fill={scene.ventricleFill} squeeze={scene.ventriclesSqueeze} />
      <Valve at={AV_RIGHT} half={14} open={scene.atrioventricularOpen} />
      <Valve at={AV_LEFT} half={14} open={scene.atrioventricularOpen} />
      <Valve at={SL_PULMONARY} half={9} open={scene.semilunarOpen} />
      <Valve at={SL_AORTIC} half={9} open={scene.semilunarOpen} />
      <Label at={{ x: 98, y: 196 }} text="RIGHT" bold />
      <Label at={{ x: 158, y: 196 }} text="LEFT" bold />
      <Label at={{ x: 228, y: 118 }} text="PRESSURE (RELATIVE)" anchor="start" bold />
      <PressureBar y={128} label="ATRIUM" level={scene.atriumPressure} />
      <PressureBar y={150} label="VENTRICLE" level={scene.ventriclePressure} />
      <PressureBar y={172} label="ARTERY" level={scene.arteryPressure} />
      {focus === 'atria' ? (
        <>
          <FocusRing at={RIGHT_ATRIUM.centre} radius={36} />
          <FocusRing at={LEFT_ATRIUM.centre} radius={36} />
        </>
      ) : null}
      {focus === 'ventricles' ? (
        <>
          <FocusRing at={RIGHT_VENTRICLE.centre} radius={44} />
          <FocusRing at={LEFT_VENTRICLE.centre} radius={46} />
        </>
      ) : null}
      {focus === 'valves' ? (
        <>
          <FocusRing at={{ x: AV_RIGHT.x, y: AV_RIGHT.y + 6 }} radius={20} />
          <FocusRing at={{ x: AV_LEFT.x, y: AV_LEFT.y + 6 }} radius={20} />
          <FocusRing at={{ x: 130, y: SL_PULMONARY.y + 6 }} radius={24} />
        </>
      ) : null}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The two loops.

function CircuitsView({ scene }: { readonly scene: CirculationScene }) {
  const { focus } = scene;
  return (
    <G>
      <Ellipse cx={160} cy={30} rx={62} ry={19} fill={PAPER_DEEP} stroke={INK} strokeWidth={OUTLINE} />
      <Label at={{ x: 160, y: 34 }} text="LUNGS" bold />
      <Ellipse cx={160} cy={170} rx={76} ry={19} fill={PAPER_DEEP} stroke={INK} strokeWidth={OUTLINE} />
      <Label at={{ x: 160, y: 174 }} text="REST OF THE BODY" bold />
      <Rect x={120} y={80} width={40} height={40} fill={POOR} opacity={0.55} stroke={INK} strokeWidth={OUTLINE} />
      <Rect x={160} y={80} width={40} height={40} fill={RICH} opacity={0.55} stroke={INK} strokeWidth={OUTLINE} />
      <Label at={{ x: 140, y: 104 }} text="RIGHT" bold />
      <Label at={{ x: 180, y: 104 }} text="LEFT" bold />
      <Arrow from={{ x: 134, y: 78 }} to={{ x: 104, y: 42 }} width={5} colour={POOR} outlined />
      <Arrow from={{ x: 216, y: 42 }} to={{ x: 186, y: 78 }} width={5} colour={RICH} outlined />
      <Arrow from={{ x: 186, y: 122 }} to={{ x: 216, y: 156 }} width={5} colour={RICH} outlined />
      <Arrow from={{ x: 104, y: 156 }} to={{ x: 134, y: 122 }} width={5} colour={POOR} outlined />
      <Label at={{ x: 270, y: 70 }} text="RED: RICH IN OXYGEN" anchor="end" />
      <Label at={{ x: 270, y: 84 }} text="BLUE: POOR IN OXYGEN" anchor="end" />
      <Label at={{ x: 270, y: 98 }} text="(A DRAWING CONVENTION)" anchor="end" />
      {focus === 'right-side' ? <FocusBox x={114} y={74} width={52} height={52} /> : null}
      {focus === 'left-side' ? <FocusBox x={154} y={74} width={52} height={52} /> : null}
      {focus === 'lungs' ? <FocusBox x={90} y={6} width={140} height={48} /> : null}
      {focus === 'body' ? <FocusBox x={74} y={146} width={172} height={48} /> : null}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Pressure along the loop through the body.

const CHART = { left: 36, right: 300, top: 22, bottom: 128 } as const;
const SECTION_WIDTH = (CHART.right - CHART.left) / 4;
const SECTION_LABELS = ['ARTERIES', 'ARTERIOLES', 'CAPILLARIES', 'VEINS'] as const;
const FOCUS_SECTION = { arteries: 0, arterioles: 1, capillaries: 2, veins: 3 } as const;

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
      y={172 - width / 2}
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
      <Label at={{ x: CHART.left, y: 196 }} text="FLOW" anchor="start" />
      <Arrow
        from={{ x: CHART.left + 28, y: 193 }}
        to={{ x: CHART.left + 70, y: 193 }}
        width={1.5 + 3 * scene.flow}
        colour={INK}
      />
      {changed ? <Label at={{ x: CHART.right, y: 196 }} text="DASHED: THE USUAL" anchor="end" /> : null}
      {focusSection === undefined ? null : (
        <FocusBox
          x={xAtSection(focusSection) + 2}
          y={CHART.top - 2}
          width={SECTION_WIDTH - 4}
          height={CHART.bottom - CHART.top + 66}
        />
      )}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Oxygen on haemoglobin.

const PLOT = { left: 38, right: 196, top: 26, bottom: 150 } as const;
const xOfOxygen = (share: number): number => PLOT.left + share * (PLOT.right - PLOT.left);
const yOfLoaded = (loaded: number): number => PLOT.bottom - loaded * (PLOT.bottom - PLOT.top);

function curvePath(curve: readonly number[]): string {
  return curve
    .map((loaded, index) => `${index === 0 ? 'M' : 'L'} ${xOfOxygen(index / (CURVE_SAMPLES - 1))} ${yOfLoaded(loaded)}`)
    .join(' ');
}

const BAR = { width: 22, top: 40, bottom: 150 } as const;

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
  const carrierX = { lungs: 224, here: 264 };
  const gapTop = BAR.bottom - (BAR.bottom - BAR.top) * scene.lungsLoaded;
  const gapBottom = BAR.bottom - (BAR.bottom - BAR.top) * scene.hereLoaded;
  return (
    <G>
      <Line x1={PLOT.left} y1={PLOT.top - 6} x2={PLOT.left} y2={PLOT.bottom} stroke={INK} strokeWidth={1.8} />
      <Line x1={PLOT.left} y1={PLOT.bottom} x2={PLOT.right + 6} y2={PLOT.bottom} stroke={INK} strokeWidth={1.8} />
      <Label at={{ x: PLOT.left + 4, y: PLOT.top - 10 }} text="HAEMOGLOBIN CARRYING OXYGEN" anchor="start" />
      <Label at={{ x: PLOT.right, y: PLOT.bottom + 13 }} text="OXYGEN AROUND: LOW TO HIGH" anchor="end" />
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
      <Label at={{ x: lungs.x - 6, y: lungs.y - 9 }} text="LUNGS" anchor="end" />
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
          <Label at={{ x: here.x + 8, y: here.y + 14 }} text="TISSUE" anchor="start" />
        </>
      ) : null}
      <Carrier x={carrierX.lungs} loaded={scene.lungsLoaded} label="LEAVING LUNGS" />
      {tissue ? (
        <>
          <Carrier x={carrierX.here} loaded={scene.hereLoaded} label="LEAVING TISSUE" />
          <Arrow
            from={{ x: carrierX.lungs + BAR.width + 4, y: (gapTop + gapBottom) / 2 }}
            to={{ x: carrierX.here - 4, y: (gapTop + gapBottom) / 2 }}
            width={3}
            colour={INK}
          />
          <Label at={{ x: 258, y: BAR.top - 8 }} text="HANDED OVER TO TISSUE" anchor="end" />
        </>
      ) : null}
      {scene.focus === 'curve' ? (
        <FocusBox
          x={PLOT.left - 6}
          y={PLOT.top - 4}
          width={PLOT.right - PLOT.left + 14}
          height={PLOT.bottom - PLOT.top + 10}
        />
      ) : null}
      {scene.focus === 'handoff' && tissue ? (
        <FocusBox
          x={here.x - 10}
          y={Math.min(lungs.y, here.y) - 10}
          width={lungs.x - here.x + 20}
          height={Math.abs(here.y - lungs.y) + 20}
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
