import type { ReactElement } from 'react';
import Svg, { Circle, Ellipse, G, Line, Path, Rect } from 'react-native-svg';
import { SCENE_HEIGHT, SCENE_WIDTH, type Point } from './earth-sky-scene';
import { courseAt, SAMPLE_MS, type NerveScene } from './nerve-scene';
import {
  Arrow,
  BLUE,
  FOCUS,
  FocusBox,
  FocusRing,
  INK,
  Label,
  MUTED,
  OUTLINE,
  PAPER,
  PAPER_DEEP,
  SUN,
  WARM,
} from './parts';

/**
 * The nerve kit drawn in the V3 style (D-201): the voltage across a nerve cell's membrane through a spike,
 * the three pushes of the all-or-none rule, a spike running along an axon, a synapse and a reflex arc. It
 * draws a scene it is given and decides nothing about the physiology (`nerve-scene.ts`): the voltage at each
 * moment, how open the channels are, the recovering stretch behind a spike and the direction of a synaptic
 * change are all derived there from a model of the membrane. No voltage is drawn as a figure. Labels are
 * decoration, hidden from assistive technology; the picture's accessible name is its description, set by
 * the caller.
 */

/** A graph of voltage against time, or along an axon, in the picture's units. */
interface Plot {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly lowest: number;
  readonly highest: number;
}

const spikePlot = (scene: NerveScene, bottom: number): Plot => ({
  left: 36,
  right: 300,
  top: 16,
  bottom,
  lowest: scene.undershootVoltage - 6,
  highest: scene.peakVoltage + 6,
});

const yOfVoltage = (plot: Plot, voltage: number): number =>
  plot.bottom - ((voltage - plot.lowest) / (plot.highest - plot.lowest)) * (plot.bottom - plot.top);

function curvePath(plot: Plot, curve: readonly number[], durationMs: number): string {
  return curve
    .map((voltage, index) => {
      const x = plot.left + ((index * SAMPLE_MS) / durationMs) * (plot.right - plot.left);
      return `${index === 0 ? 'M' : 'L'} ${x} ${yOfVoltage(plot, voltage)}`;
    })
    .join(' ');
}

/** The voltage of a sampled curve at a time, between its samples. */
function voltageAt(curve: readonly number[], timeMs: number): number {
  const position = Math.min(curve.length - 1, Math.max(0, timeMs / SAMPLE_MS));
  const before = Math.floor(position);
  const after = Math.min(curve.length - 1, before + 1);
  const share = position - before;
  return (curve[before] ?? 0) * (1 - share) + (curve[after] ?? 0) * share;
}

function Axes({ plot, timeLabel }: { readonly plot: Plot; readonly timeLabel: string }) {
  return (
    <G>
      <Line x1={plot.left} y1={plot.top - 4} x2={plot.left} y2={plot.bottom} stroke={INK} strokeWidth={1.8} />
      <Line x1={plot.left} y1={plot.bottom} x2={plot.right + 6} y2={plot.bottom} stroke={INK} strokeWidth={1.8} />
      <Label at={{ x: plot.left + 4, y: plot.top - 6 }} text="VOLTAGE: INSIDE AGAINST OUTSIDE" anchor="start" />
      <Label at={{ x: plot.right, y: plot.bottom + 12 }} text={timeLabel} anchor="end" />
    </G>
  );
}

function Levels({ scene, plot }: { readonly scene: NerveScene; readonly plot: Plot }) {
  const rest = yOfVoltage(plot, scene.restVoltage);
  const threshold = yOfVoltage(plot, scene.thresholdVoltage);
  const zero = yOfVoltage(plot, 0);
  return (
    <G>
      <Line x1={plot.left} y1={zero} x2={plot.right} y2={zero} stroke={MUTED} strokeWidth={1} strokeDasharray="1 4" />
      <Label at={{ x: plot.left + 4, y: zero - 3 }} text="0" anchor="start" />
      <Line x1={plot.left} y1={rest} x2={plot.right} y2={rest} stroke={MUTED} strokeWidth={1.2} strokeDasharray="4 4" />
      <Label at={{ x: plot.right, y: rest + 11 }} text="REST" anchor="end" />
      <Line
        x1={plot.left}
        y1={threshold}
        x2={plot.right}
        y2={threshold}
        stroke={FOCUS}
        strokeWidth={1.4}
        strokeDasharray="6 3"
      />
      <Label at={{ x: plot.right, y: threshold - 3 }} text="THRESHOLD" anchor="end" />
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// One spike, with the channels.

const SPIKE_MS = 16;
const MEMBRANE = { top: 150, bottom: 164 } as const;

/** A channel in the membrane: two blocks with a gap between them that is wider the more open it is. */
function Channel({ x, open }: { readonly x: number; readonly open: number }) {
  const gap = 2 + 12 * open;
  return (
    <G>
      <Rect
        x={x - gap / 2 - 12}
        y={MEMBRANE.top - 2}
        width={12}
        height={MEMBRANE.bottom - MEMBRANE.top + 4}
        fill={INK}
      />
      <Rect x={x + gap / 2} y={MEMBRANE.top - 2} width={12} height={MEMBRANE.bottom - MEMBRANE.top + 4} fill={INK} />
    </G>
  );
}

function SpikeView({ scene }: { readonly scene: NerveScene }) {
  const plot = spikePlot(scene, 108);
  const marker: Point = {
    x: plot.left + (scene.markerTime / SPIKE_MS) * (plot.right - plot.left),
    y: yOfVoltage(plot, voltageAt(scene.curve, scene.markerTime)),
  };
  const sodiumX = 100;
  const potassiumX = 220;
  const thresholdY = yOfVoltage(plot, scene.thresholdVoltage);
  return (
    <G>
      <Axes plot={plot} timeLabel="TIME" />
      <Levels scene={scene} plot={plot} />
      <Path
        d={curvePath(plot, scene.curve, SPIKE_MS)}
        fill="none"
        stroke={INK}
        strokeWidth={2.8}
        strokeLinejoin="round"
      />
      <Circle cx={marker.x} cy={marker.y} r={5.5} fill={SUN} stroke={INK} strokeWidth={1.8} />
      <Rect
        x={30}
        y={MEMBRANE.top}
        width={270}
        height={MEMBRANE.bottom - MEMBRANE.top}
        fill={PAPER_DEEP}
        stroke={INK}
        strokeWidth={1.6}
      />
      <Label at={{ x: 304, y: 140 }} text="OUTSIDE" anchor="end" />
      <Label at={{ x: 304, y: 182 }} text="INSIDE" anchor="end" />
      <Channel x={sodiumX} open={scene.sodiumOpen} />
      <Channel x={potassiumX} open={scene.potassiumOpen} />
      {scene.sodiumShut > 0.5 ? (
        <Circle cx={sodiumX} cy={MEMBRANE.bottom + 9} r={7} fill={WARM} stroke={INK} strokeWidth={1.6} />
      ) : null}
      {scene.sodiumOpen > 0.04 ? (
        <Arrow
          from={{ x: sodiumX, y: 128 }}
          to={{ x: sodiumX, y: 176 }}
          width={1 + 6 * scene.sodiumOpen}
          colour={SUN}
          outlined
        />
      ) : null}
      {scene.potassiumOpen > 0.04 ? (
        <Arrow
          from={{ x: potassiumX, y: 176 }}
          to={{ x: potassiumX, y: 128 }}
          width={1 + 6 * scene.potassiumOpen}
          colour={BLUE}
          outlined
        />
      ) : null}
      <Label at={{ x: sodiumX, y: 196 }} text="SODIUM CHANNEL" bold />
      <Label at={{ x: potassiumX, y: 196 }} text="POTASSIUM CHANNEL" bold />
      {scene.focus === 'trace' ? (
        <FocusBox
          x={plot.left - 4}
          y={plot.top - 2}
          width={plot.right - plot.left + 10}
          height={plot.bottom - plot.top + 8}
        />
      ) : null}
      {scene.focus === 'threshold' ? (
        <FocusBox x={plot.left - 2} y={thresholdY - 9} width={plot.right - plot.left + 6} height={18} />
      ) : null}
      {scene.focus === 'channels' ? <FocusBox x={30} y={122} width={274} height={64} /> : null}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Three pushes.

const PUSH_MS = 12;

function AllOrNoneView({ scene }: { readonly scene: NerveScene }) {
  const plot = spikePlot(scene, 150);
  const strongTop: Point = {
    x:
      plot.left +
      ((scene.strongCurve.indexOf(Math.max(...scene.strongCurve)) * SAMPLE_MS) / PUSH_MS) * (plot.right - plot.left),
    y: yOfVoltage(plot, Math.max(...scene.strongCurve)),
  };
  const weakTop: Point = {
    x:
      plot.left +
      ((scene.weakCurve.indexOf(Math.max(...scene.weakCurve)) * SAMPLE_MS) / PUSH_MS) * (plot.right - plot.left),
    y: yOfVoltage(plot, Math.max(...scene.weakCurve)),
  };
  const legend = (y: number, colour: string, text: string) => (
    <G>
      <Line x1={236} y1={y - 3} x2={254} y2={y - 3} stroke={colour} strokeWidth={3} />
      <Label at={{ x: 258, y }} text={text} anchor="start" />
    </G>
  );
  return (
    <G>
      <Axes plot={plot} timeLabel="TIME" />
      <Levels scene={scene} plot={plot} />
      <Path
        d={curvePath(plot, scene.weakCurve, PUSH_MS)}
        fill="none"
        stroke={MUTED}
        strokeWidth={2.8}
        strokeLinejoin="round"
      />
      <Path
        d={curvePath(plot, scene.enoughCurve, PUSH_MS)}
        fill="none"
        stroke={INK}
        strokeWidth={2.8}
        strokeLinejoin="round"
      />
      <Path
        d={curvePath(plot, scene.strongCurve, PUSH_MS)}
        fill="none"
        stroke={BLUE}
        strokeWidth={2.8}
        strokeLinejoin="round"
      />
      {legend(30, MUTED, 'WEAK PUSH')}
      {legend(44, INK, 'STRONGER')}
      {legend(58, BLUE, 'STRONGEST')}
      <Label at={{ x: 160, y: 178 }} text="A WEAK PUSH DIES AWAY; THE OTHERS GIVE THE SAME SPIKE" bold />
      {scene.focus === 'threshold' ? (
        <FocusBox
          x={plot.left - 2}
          y={yOfVoltage(plot, scene.thresholdVoltage) - 9}
          width={plot.right - plot.left + 6}
          height={18}
        />
      ) : null}
      {scene.focus === 'weak-push' ? <FocusRing at={weakTop} radius={16} /> : null}
      {scene.focus === 'strong-push' ? <FocusRing at={strongTop} radius={16} /> : null}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The spike along an axon.

const TUBE = { left: 72, right: 300, centre: 150, half: 9 } as const;
/** How much of the axon the spike's whole time course covers, as a share of its length. */
const PROFILE_WIDTH = 0.4;

function AxonView({ scene }: { readonly scene: NerveScene }) {
  const plot: Plot = { ...spikePlot(scene, 116), left: TUBE.left, right: TUBE.right };
  const length = TUBE.right - TUBE.left;
  const count = scene.profile.length;
  const startX = TUBE.left + (scene.peakAt - scene.peakShare * PROFILE_WIDTH) * length;
  const xOf = (index: number): number => startX + (index / (count - 1)) * PROFILE_WIDTH * length;
  const rest = yOfVoltage(plot, scene.restVoltage);
  const path = [
    `M ${TUBE.left} ${rest}`,
    ...scene.profile.map((voltage, index) => `L ${xOf(index)} ${yOfVoltage(plot, voltage)}`),
    `L ${TUBE.right} ${rest}`,
  ].join(' ');
  const peakIndex = scene.profile.indexOf(Math.max(...scene.profile));
  const peak: Point = { x: xOf(peakIndex), y: yOfVoltage(plot, Math.max(...scene.profile)) };
  const recoveringIndexes = scene.recovering.flatMap((flag, index) => (flag > 0.5 ? [index] : []));
  const recoveringFrom = Math.min(...recoveringIndexes);
  const recoveringTo = Math.max(...recoveringIndexes);
  const segmentFill = (index: number): string =>
    (scene.recovering[index] ?? 0) > 0.5
      ? WARM
      : (scene.profile[index] ?? scene.restVoltage) > scene.thresholdVoltage
        ? SUN
        : PAPER;
  return (
    <G>
      <Axes plot={plot} timeLabel="ALONG THE AXON" />
      <Levels scene={scene} plot={plot} />
      <Ellipse cx={38} cy={TUBE.centre} rx={26} ry={24} fill={PAPER_DEEP} stroke={INK} strokeWidth={OUTLINE} />
      <Label at={{ x: 38, y: TUBE.centre + 3 }} text="CELL BODY" bold />
      <Rect
        x={TUBE.left}
        y={TUBE.centre - TUBE.half}
        width={length}
        height={TUBE.half * 2}
        fill={PAPER}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      {scene.profile.slice(0, -1).map((_, index) => (
        <Rect
          key={index}
          x={xOf(index)}
          y={TUBE.centre - TUBE.half + 1}
          width={xOf(index + 1) - xOf(index) + 0.5}
          height={TUBE.half * 2 - 2}
          fill={segmentFill(index)}
          opacity={0.75}
        />
      ))}
      <Path d={path} fill="none" stroke={INK} strokeWidth={2.8} strokeLinejoin="round" />
      <Label at={{ x: xOf(Math.floor((recoveringFrom + recoveringTo) / 2)), y: 178 }} text="RECOVERING" bold />
      <Label at={{ x: Math.min(TUBE.right - 30, xOf(count - 1) + 34), y: 178 }} text="AT REST, READY" />
      <Arrow from={{ x: 120, y: 192 }} to={{ x: 220, y: 192 }} width={2.5} colour={INK} />
      <Label at={{ x: 226, y: 195 }} text="THE SIGNAL RUNS THIS WAY" anchor="start" />
      {scene.focus === 'spike' ? <FocusRing at={peak} radius={18} /> : null}
      {scene.focus === 'recovering' ? (
        <FocusBox
          x={xOf(recoveringFrom) - 3}
          y={plot.top}
          width={xOf(recoveringTo) - xOf(recoveringFrom) + 6}
          height={TUBE.centre + TUBE.half + 8 - plot.top}
        />
      ) : null}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A synapse.

const SENDING = { left: 22, right: 118, top: 30, bottom: 112 } as const;
const RECEIVING = { left: 172, right: 314 } as const;
const VESICLES: readonly Point[] = [
  { x: 50, y: 52 },
  { x: 76, y: 66 },
  { x: 52, y: 90 },
  { x: 80, y: 96 },
  { x: 104, y: 70 },
];
const RECEPTORS = [48, 72, 96] as const;
const GAP_DOTS: readonly { share: number; y: number }[] = [
  { share: 0, y: 52 },
  { share: 0.3, y: 64 },
  { share: 0.15, y: 80 },
  { share: 0.55, y: 92 },
  { share: 0.4, y: 56 },
  { share: 0.7, y: 74 },
  { share: 0.85, y: 100 },
];
const COURSE = { left: 184, right: 304, rest: 176, pixelsPerMillivolt: 5.5, constants: 5 } as const;

function SynapseView({ scene }: { readonly scene: NerveScene }) {
  const released = scene.released > 0.5;
  const bound = scene.receptorsOpen > 0.5;
  const gapWidth = RECEIVING.left - SENDING.right;
  const courseX = (time: number): number => COURSE.left + (time / COURSE.constants) * (COURSE.right - COURSE.left);
  const courseY = (shift: number): number => COURSE.rest - shift * COURSE.pixelsPerMillivolt;
  const thresholdShift = scene.thresholdVoltage - scene.restVoltage;
  const effectShown = scene.synapseTime >= 1;
  const fullCourse = Array.from({ length: 41 }, (_, index) => {
    const time = (index * COURSE.constants) / 40;
    return `${index === 0 ? 'M' : 'L'} ${courseX(time)} ${courseY(courseAt(time) * scene.fullShift)}`;
  }).join(' ');
  return (
    <G>
      <Rect x={0} y={54} width={SENDING.left + 2} height={22} fill={PAPER_DEEP} stroke={INK} strokeWidth={OUTLINE} />
      <Rect
        x={SENDING.left}
        y={SENDING.top}
        width={SENDING.right - SENDING.left}
        height={SENDING.bottom - SENDING.top}
        rx={18}
        fill={PAPER_DEEP}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      <Label at={{ x: 66, y: SENDING.top - 6 }} text="SENDING CELL" bold />
      {scene.released < 0.5 ? <Label at={{ x: 12, y: 48 }} text="SPIKE" anchor="start" /> : null}
      {VESICLES.map((at, index) => {
        const fused = released && index === VESICLES.length - 1;
        return fused ? (
          <Circle
            key={index}
            cx={SENDING.right - 4}
            cy={at.y}
            r={6}
            fill={PAPER}
            stroke={INK}
            strokeWidth={1.6}
            strokeDasharray="3 2"
          />
        ) : (
          <Circle key={index} cx={at.x} cy={at.y} r={7} fill={SUN} stroke={INK} strokeWidth={1.6} />
        );
      })}
      <Rect
        x={RECEIVING.left}
        y={SENDING.top - 6}
        width={RECEIVING.right - RECEIVING.left}
        height={SENDING.bottom - SENDING.top + 12}
        rx={10}
        fill={PAPER_DEEP}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      <Label at={{ x: 246, y: SENDING.top - 10 }} text="NEXT CELL" bold />
      <Label at={{ x: SENDING.right + gapWidth / 2, y: SENDING.bottom + 22 }} text="GAP" bold />
      {RECEPTORS.map((y) => {
        const open = bound ? 9 : 2;
        return (
          <G key={y}>
            <Rect x={RECEIVING.left - 5} y={y - 6 - open / 2} width={10} height={6} fill={INK} />
            <Rect x={RECEIVING.left - 5} y={y + open / 2} width={10} height={6} fill={INK} />
            {bound ? <Circle cx={RECEIVING.left + 1} cy={y} r={2.8} fill={SUN} stroke={INK} strokeWidth={1} /> : null}
          </G>
        );
      })}
      {scene.inGap > 0.5
        ? GAP_DOTS.map((dot, index) => {
            const share = Math.min(1, dot.share * 0.5 + scene.gapProgress * 0.55 + (index % 3) * 0.04);
            return (
              <Circle
                key={index}
                cx={SENDING.right + 6 + share * (gapWidth - 14)}
                cy={dot.y}
                r={3.2}
                fill={WARM}
                stroke={INK}
                strokeWidth={1}
              />
            );
          })
        : null}
      <Label at={{ x: COURSE.left, y: 128 }} text="NEXT CELL’S VOLTAGE" anchor="start" />
      <Line
        x1={COURSE.left}
        y1={courseY(0)}
        x2={COURSE.right}
        y2={courseY(0)}
        stroke={MUTED}
        strokeWidth={1.2}
        strokeDasharray="4 4"
      />
      <Label at={{ x: COURSE.right, y: courseY(0) + 11 }} text="REST" anchor="end" />
      <Line
        x1={COURSE.left}
        y1={courseY(thresholdShift)}
        x2={COURSE.right}
        y2={courseY(thresholdShift)}
        stroke={FOCUS}
        strokeWidth={1.4}
        strokeDasharray="6 3"
      />
      <Label at={{ x: COURSE.right, y: courseY(thresholdShift) - 3 }} text="THRESHOLD" anchor="end" />
      {effectShown ? <Path d={fullCourse} fill="none" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" /> : null}
      <Circle
        cx={courseX(scene.synapseTime)}
        cy={courseY(scene.shift)}
        r={5}
        fill={SUN}
        stroke={INK}
        strokeWidth={1.8}
      />
      {scene.focus === 'vesicles' ? (
        <FocusBox
          x={SENDING.left + 8}
          y={SENDING.top + 10}
          width={SENDING.right - SENDING.left - 8}
          height={SENDING.bottom - SENDING.top - 18}
        />
      ) : null}
      {scene.focus === 'gap' ? (
        <FocusBox
          x={SENDING.right + 2}
          y={SENDING.top - 6}
          width={gapWidth - 4}
          height={SENDING.bottom - SENDING.top + 12}
        />
      ) : null}
      {scene.focus === 'receptors' ? (
        <FocusBox x={RECEIVING.left - 12} y={RECEPTORS[0] - 16} width={26} height={RECEPTORS[2] - RECEPTORS[0] + 32} />
      ) : null}
    </G>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A reflex arc.

const SENSOR: Point = { x: 40, y: 168 };
const CORD = { x: 142, y: 66, width: 28, height: 112 } as const;
const MUSCLE: Point = { x: 268, y: 168 };
const BRAIN: Point = { x: 156, y: 22 };

function Link({
  from,
  to,
  lit,
  dashed = false,
}: {
  readonly from: Point;
  readonly to: Point;
  readonly lit: number;
  readonly dashed?: boolean;
}) {
  return lit > 0.5 ? (
    <Arrow from={from} to={to} width={3.4} colour={INK} />
  ) : (
    <Line
      x1={from.x}
      y1={from.y}
      x2={to.x}
      y2={to.y}
      stroke={MUTED}
      strokeWidth={2}
      strokeDasharray={dashed ? '3 4' : '5 4'}
    />
  );
}

function ReflexView({ scene }: { readonly scene: NerveScene }) {
  const lit = (flag: number) => (flag > 0.5 ? SUN : PAPER_DEEP);
  const contracted = scene.muscleLit > 0.5;
  return (
    <G>
      <Link from={{ x: SENSOR.x + 10, y: SENSOR.y - 5 }} to={{ x: CORD.x - 2, y: 134 }} lit={scene.sensoryLit} />
      <Link
        from={{ x: CORD.x + CORD.width + 2, y: 134 }}
        to={{ x: MUSCLE.x - 30, y: MUSCLE.y - 6 }}
        lit={scene.motorLit}
      />
      <Link
        from={{ x: CORD.x + CORD.width / 2, y: CORD.y - 2 }}
        to={{ x: BRAIN.x, y: BRAIN.y + 16 }}
        lit={scene.brainLit}
        dashed={scene.newsOnItsWay > 0.5}
      />
      {scene.newsOnItsWay > 0.5 && scene.brainLit < 0.5 ? (
        <Arrow
          from={{ x: CORD.x + CORD.width / 2, y: CORD.y - 2 }}
          to={{ x: BRAIN.x, y: BRAIN.y + 18 }}
          width={2.4}
          colour={INK}
          opacity={0.5}
        />
      ) : null}
      <Rect
        x={CORD.x}
        y={CORD.y}
        width={CORD.width}
        height={CORD.height}
        rx={10}
        fill={lit(scene.cordLit)}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      <Circle cx={SENSOR.x} cy={SENSOR.y} r={10} fill={lit(scene.sensorLit)} stroke={INK} strokeWidth={OUTLINE} />
      <Ellipse
        cx={MUSCLE.x}
        cy={MUSCLE.y}
        rx={contracted ? 20 : 28}
        ry={contracted ? 14 : 9}
        fill={lit(scene.muscleLit)}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      <Ellipse
        cx={BRAIN.x}
        cy={BRAIN.y}
        rx={32}
        ry={15}
        fill={lit(scene.brainLit)}
        stroke={INK}
        strokeWidth={OUTLINE}
      />
      <Label at={{ x: BRAIN.x, y: BRAIN.y + 3 }} text="BRAIN" bold />
      <Label at={{ x: SENSOR.x, y: SENSOR.y + 24 }} text="SENSOR" bold />
      <Label at={{ x: 96, y: 138 }} text="SENSORY NEURON" />
      <Label at={{ x: CORD.x + CORD.width + 8, y: CORD.y + 22 }} text="SPINAL CORD" anchor="start" bold />
      <Label at={{ x: 226, y: 148 }} text="MOTOR NEURON" />
      <Label at={{ x: MUSCLE.x, y: MUSCLE.y + 26 }} text="MUSCLE" bold />
      {scene.newsOnItsWay > 0.5 && scene.brainLit < 0.5 ? (
        <Label at={{ x: BRAIN.x + 44, y: 52 }} text="NEWS ON ITS WAY" anchor="start" />
      ) : null}
      {scene.focus === 'sensor' ? <FocusRing at={SENSOR} radius={20} /> : null}
      {scene.focus === 'sensory-neuron' ? <FocusBox x={44} y={118} width={92} height={50} /> : null}
      {scene.focus === 'spinal-cord' ? (
        <FocusBox x={CORD.x - 6} y={CORD.y - 6} width={CORD.width + 12} height={CORD.height + 12} />
      ) : null}
      {scene.focus === 'motor-neuron' ? <FocusBox x={176} y={120} width={64} height={48} /> : null}
      {scene.focus === 'muscle' ? <FocusRing at={MUSCLE} radius={36} /> : null}
      {scene.focus === 'brain' ? <FocusRing at={BRAIN} radius={38} /> : null}
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function NervePicture({ scene }: { readonly scene: NerveScene }): ReactElement {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {scene.view === 'spike' ? <SpikeView scene={scene} /> : null}
      {scene.view === 'all-or-none' ? <AllOrNoneView scene={scene} /> : null}
      {scene.view === 'axon' ? <AxonView scene={scene} /> : null}
      {scene.view === 'synapse' ? <SynapseView scene={scene} /> : null}
      {scene.view === 'reflex' ? <ReflexView scene={scene} /> : null}
    </Svg>
  );
}
