import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Polygon, Rect } from 'react-native-svg';
import { SCENE_HEIGHT, SCENE_WIDTH, onCircle, type Point } from './earth-sky-scene';
import { Arrow, FOCUS, FocusRing, INK, Label, MUTED, OUTLINE, PAPER_DEEP, SUN, WARM } from './parts';
import type { StarScene } from './star-scene';

/**
 * The star kit drawn in the V3 style (D-194): a star cut open with its core and the two forces, three stars of
 * different mass with how long each shines, and one star through the stages of its life. It draws a scene it
 * is given and decides nothing about the physics (`star-scene.ts`). Labels are decoration, hidden from
 * assistive technology; the picture's accessible name is its description, set by the caller.
 */

const SURFACE_COLOUR = { cool: '#EE6A3F', middle: SUN, hot: '#C4D7FF' } as const;
const CORE = '#FF7A3D';
const GAS = '#B9A5DA';

/** A star's disc in the colour of its surface. */
function StarDisc({
  at,
  radius,
  surface,
}: {
  readonly at: Point;
  readonly radius: number;
  readonly surface: StarScene['surface'];
}) {
  return (
    <G>
      <Circle cx={at.x} cy={at.y} r={radius * 1.25} fill={SURFACE_COLOUR[surface]} opacity={0.28} />
      <Circle cx={at.x} cy={at.y} r={radius} fill={SURFACE_COLOUR[surface]} stroke={INK} strokeWidth={OUTLINE} />
    </G>
  );
}

/** A star cut open: the core where hydrogen fuses, gravity pulling in from outside and pressure pushing out from within. */
function BalanceView({ scene }: { readonly scene: StarScene }) {
  const centre = { x: 160, y: 100 };
  const base = scene.radiusPx;
  const drawn = scene.motion === 'holds' ? base : scene.motion === 'shrinks' ? base * 0.82 : base * 1.18;
  const core = 15;
  const inward = [45, 135, 225, 315];
  const outward = [0, 90, 180, 270];
  return (
    <G>
      {scene.motion === 'holds' ? null : (
        <Circle cx={centre.x} cy={centre.y} r={base} fill="none" stroke={INK} strokeWidth={1.6} strokeDasharray="6 5" />
      )}
      <StarDisc at={centre} radius={drawn} surface="middle" />
      <Circle cx={centre.x} cy={centre.y} r={drawn * 0.55} fill="#FFB84D" opacity={0.55} />
      <Circle cx={centre.x} cy={centre.y} r={core} fill={CORE} stroke={INK} strokeWidth={OUTLINE} />
      <Label at={{ x: 22, y: 190 }} text="CORE: HYDROGEN → HELIUM" anchor="start" bold />
      {inward.map((degrees) => (
        <Arrow
          key={degrees}
          from={onCircle(centre, base + 34, degrees)}
          to={onCircle(centre, base + 34 - 26 * scene.gravity, degrees)}
          width={4.5}
          colour={INK}
        />
      ))}
      {outward.map((degrees) => (
        <Arrow
          key={degrees}
          from={onCircle(centre, core + 5, degrees)}
          to={onCircle(centre, core + 5 + 26 * scene.pressure, degrees)}
          width={4.5}
          colour={WARM}
        />
      ))}
      <Label at={{ x: 22, y: 28 }} text="GRAVITY IN" anchor="start" bold />
      <Label at={{ x: 22, y: 42 }} text="PRESSURE OUT" anchor="start" bold />
      <Arrow from={{ x: 112, y: 24 }} to={{ x: 132, y: 24 }} width={4} colour={INK} />
      <Arrow from={{ x: 112, y: 38 }} to={{ x: 132, y: 38 }} width={4} colour={WARM} />
      {scene.focus === 'core' ? <FocusRing at={centre} radius={core + 10} /> : null}
      {scene.focus === 'gravity' ? <FocusRing at={onCircle(centre, base + 20, 45)} radius={22} /> : null}
      {scene.focus === 'pressure' ? <FocusRing at={onCircle(centre, core + 24, 0)} radius={20} /> : null}
    </G>
  );
}

const MASS_LABELS = ['LOW MASS', 'LIKE THE SUN', 'HIGH MASS'] as const;
const SURFACE_OF_MASS = ['cool', 'middle', 'hot'] as const;

/** Three stars side by side and how long each shines, on a stretched scale, with the chosen one marked. */
function MassView({ scene }: { readonly scene: StarScene }) {
  const barLeft = (index: number): number => 20 + index * 100;
  return (
    <G>
      {scene.radii.map((radius, index) => {
        const centre = { x: barLeft(index) + 40, y: 62 };
        const marked = index === scene.markedMass;
        return (
          <G key={MASS_LABELS[index]}>
            <StarDisc at={centre} radius={radius} surface={SURFACE_OF_MASS[index] ?? 'middle'} />
            {marked ? (
              <Circle
                cx={centre.x}
                cy={centre.y}
                r={Math.max(...scene.radii) + 6}
                fill="none"
                stroke={FOCUS}
                strokeWidth={3}
              />
            ) : null}
            <Label at={{ x: centre.x, y: 128 }} text={MASS_LABELS[index] ?? ''} bold={marked} />
            <Rect x={barLeft(index)} y={138} width={80} height={14} fill={PAPER_DEEP} stroke={INK} strokeWidth={1.6} />
            <Rect
              x={barLeft(index)}
              y={138}
              width={80 * (scene.lifetimes[index] ?? 0)}
              height={14}
              fill={marked ? FOCUS : MUTED}
              stroke={INK}
              strokeWidth={1.6}
            />
          </G>
        );
      })}
      <Label at={{ x: 20, y: 172 }} text="HOW LONG IT SHINES (STRETCHED SCALE)" anchor="start" />
      {scene.focus === 'lifetime' ? (
        <Rect x={14} y={132} width={292} height={26} fill="none" stroke={FOCUS} strokeWidth={3} strokeDasharray="5 4" />
      ) : null}
    </G>
  );
}

/** A cloud of gas: overlapping blobs, denser toward the middle. */
function Cloud({ at }: { readonly at: Point }) {
  const blobs = [
    { x: -22, y: -8, r: 26 },
    { x: 18, y: -14, r: 24 },
    { x: 4, y: 18, r: 28 },
    { x: -14, y: 14, r: 20 },
    { x: 24, y: 12, r: 20 },
  ];
  return (
    <G>
      {blobs.map((blob) => (
        <Circle key={`${blob.x},${blob.y}`} cx={at.x + blob.x} cy={at.y + blob.y} r={blob.r} fill={GAS} opacity={0.5} />
      ))}
      <Circle cx={at.x} cy={at.y} r={9} fill={GAS} stroke={INK} strokeWidth={1.6} />
    </G>
  );
}

/** A supernova: a ring of spikes round the dense remnant it leaves. */
function Supernova({ at, radius }: { readonly at: Point; readonly radius: number }) {
  const points = Array.from({ length: 24 }, (_, index) => {
    const point = onCircle(at, index % 2 === 0 ? radius : radius * 0.5, index * 15);
    return `${point.x},${point.y}`;
  }).join(' ');
  return (
    <G>
      <Polygon points={points} fill={SUN} stroke={INK} strokeWidth={OUTLINE} strokeLinejoin="round" />
      <Circle cx={at.x} cy={at.y} r={radius * 0.3} fill={CORE} />
      <Circle cx={at.x} cy={at.y} r={5} fill={INK} />
    </G>
  );
}

const STAGE_LABELS = ['CLOUD', 'STAR', 'GIANT', 'END'] as const;

/** One star at one stage of its life, with the four stages in a row below (no years). */
function LifeView({ scene }: { readonly scene: StarScene }) {
  const centre = { x: 160, y: 76 };
  return (
    <G>
      {scene.stage === 'cloud' ? <Cloud at={centre} /> : null}
      {scene.stage === 'main-sequence' || scene.stage === 'giant' ? (
        <StarDisc at={centre} radius={scene.radiusPx} surface={scene.surface} />
      ) : null}
      {scene.stage === 'end' && scene.end === 'white-dwarf' ? (
        <G>
          <Circle cx={centre.x} cy={centre.y} r={56} fill="none" stroke={GAS} strokeWidth={5} opacity={0.5} />
          <Circle
            cx={centre.x}
            cy={centre.y}
            r={38}
            fill="none"
            stroke={GAS}
            strokeWidth={3}
            strokeDasharray="4 4"
            opacity={0.7}
          />
          <StarDisc at={centre} radius={scene.radiusPx} surface="hot" />
        </G>
      ) : null}
      {scene.stage === 'end' && scene.end === 'supernova' ? (
        <Supernova at={centre} radius={scene.radiusPx + 20} />
      ) : null}
      {scene.focus === 'remnant' ? <FocusRing at={centre} radius={scene.end === 'supernova' ? 18 : 20} /> : null}
      <Line x1={70} y1={170} x2={250} y2={170} stroke={INK} strokeWidth={1.6} />
      {STAGE_LABELS.map((name, index) => {
        const x = 70 + index * 60;
        const current = index === scene.stageIndex;
        return (
          <G key={name}>
            <Circle
              cx={x}
              cy={170}
              r={current ? 7 : 5}
              fill={current ? FOCUS : PAPER_DEEP}
              stroke={INK}
              strokeWidth={1.8}
            />
            <Label at={{ x, y: 189 }} text={name} bold={current} />
          </G>
        );
      })}
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function StarPicture({ scene }: { readonly scene: StarScene }): ReactElement {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {scene.view === 'balance' ? <BalanceView scene={scene} /> : null}
      {scene.view === 'mass' ? <MassView scene={scene} /> : null}
      {scene.view === 'life' ? <LifeView scene={scene} /> : null}
    </Svg>
  );
}
