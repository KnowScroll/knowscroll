import type { ReactElement } from 'react';
import Svg, { Circle, G, Line, Path, Polygon, Text as SvgText } from 'react-native-svg';
import { fontFamily } from '@knowscroll/design-tokens';
import { SCENE_HEIGHT, SCENE_WIDTH, onCircle, type Point } from './earth-sky-scene';
import { FocusBox } from './focus-box';
import type { BlackHoleScene } from './black-hole-scene';
import { DISC_FLATNESS, ORBIT_ARROW_PX, PULL_ARROW_PX, WAVES } from './black-hole-scene';
import { Arrow, BLUE, FOCUS, FocusRing, INK, Label, MUTED, OUTLINE, PAPER, PAPER_DEEP, SUN, WARM } from './parts';

/**
 * The black-hole kit drawn in the V3 style (D-204): how a star's end can leave a black hole, black holes to
 * scale with their event horizon, the same pull from a star and a black hole of equal mass, and four clues
 * (orbits, a glowing disc, ripples from a merger, a shadow). It draws a scene it is given and decides nothing
 * about the physics (`black-hole-scene.ts`), and it draws nothing at a black hole's centre. Labels are
 * decoration, hidden from assistive technology; the picture's accessible name is its description.
 */

const HOT_STAR = '#C4D7FF';
const RED_STAR = '#EE6A3F';
const WHITE_DWARF = '#E6EEFF';
const CORE = '#FF7A3D';
const GAS = '#B9A5DA';
const GLOW = '#FFB84D';

/** A label in paper colour, for the dark discs. */
function LightLabel({ at, text }: { readonly at: Point; readonly text: string }): ReactElement {
  return (
    <SvgText x={at.x} y={at.y} fontSize={8.5} fontFamily={fontFamily.mono} fill={PAPER} textAnchor="middle">
      {text}
    </SvgText>
  );
}

/** A dark disc: a black hole, or the horizon of one. */
function Hole({ at, radius }: { readonly at: Point; readonly radius: number }): ReactElement {
  return <Circle cx={at.x} cy={at.y} r={radius} fill={INK} stroke={INK} strokeWidth={OUTLINE} />;
}

/** A ring-shaped part, as an even-odd path of two circles or two flattened ellipses. */
function ringPath(centre: Point, outerRadius: number, innerRadius: number, flatness: number): string {
  const ellipse = (radius: number): string =>
    `M ${centre.x - radius} ${centre.y} A ${radius} ${radius * flatness} 0 1 0 ${centre.x + radius} ${centre.y} A ${radius} ${radius * flatness} 0 1 0 ${centre.x - radius} ${centre.y} Z`;
  return `${ellipse(outerRadius)} ${ellipse(innerRadius)}`;
}

/** A burst of spikes round a point: a supernova. */
function Burst({ at, radius }: { readonly at: Point; readonly radius: number }): ReactElement {
  const points = Array.from({ length: 24 }, (_, index) => {
    const point = onCircle(at, index % 2 === 0 ? radius : radius * 0.55, index * 15);
    return `${point.x},${point.y}`;
  }).join(' ');
  return <Polygon points={points} fill={SUN} stroke={INK} strokeWidth={OUTLINE} strokeLinejoin="round" />;
}

const STAGE_NAMES = ['FUSING', 'FUEL OUT', 'END'] as const;
const CAPTIONS = {
  massive: ['FUSING HYDROGEN', 'THE CORE COLLAPSES', 'SUPERNOVA · A BLACK HOLE CAN FORM'],
  sunLike: ['FUSING HYDROGEN', 'SWELLS INTO A RED GIANT', 'WHITE DWARF · NOT A BLACK HOLE'],
} as const;

/** The end of a massive star beside the end of a star like the Sun: the same three steps, two different ends. */
function FormationView({ scene }: { readonly scene: BlackHoleScene }) {
  const centre = { x: 160, y: 80 };
  const massive = scene.massive >= 0.5;
  const stage = Math.round(scene.stageIndex);
  const showForces = stage === 0 || (stage === 1 && massive);
  const base = scene.starRadiusPx;
  const core = scene.coreRadiusPx;
  const starColour = stage === 1 ? RED_STAR : massive ? HOT_STAR : SUN;
  return (
    <G>
      <Label
        at={{ x: 14, y: 16 }}
        text={massive ? 'A STAR MANY TIMES THE SUN’S MASS' : 'A STAR LIKE THE SUN'}
        anchor="start"
        bold
      />
      {stage < 2 ? (
        <G>
          <Circle cx={centre.x} cy={centre.y} r={base * 1.25} fill={starColour} opacity={0.28} />
          <Circle cx={centre.x} cy={centre.y} r={base} fill={starColour} stroke={INK} strokeWidth={OUTLINE} />
          <Circle cx={centre.x} cy={centre.y} r={core} fill={CORE} stroke={INK} strokeWidth={OUTLINE} />
        </G>
      ) : null}
      {showForces
        ? [45, 135, 225, 315].map((degrees) => (
            <Arrow
              key={`in-${degrees}`}
              from={onCircle(centre, base + 18, degrees)}
              to={onCircle(centre, base - 6, degrees)}
              width={4.5 * scene.gravity}
              colour={INK}
            />
          ))
        : null}
      {showForces
        ? [0, 90, 180, 270].map((degrees) => (
            <Arrow
              key={`out-${degrees}`}
              from={onCircle(centre, core + 3, degrees)}
              to={onCircle(centre, core + 3 + 22 * scene.pressure, degrees)}
              width={4.5}
              colour={WARM}
            />
          ))
        : null}
      {showForces ? (
        <G>
          <Label at={{ x: 14, y: 30 }} text="GRAVITY IN" anchor="start" />
          <Label at={{ x: 14, y: 42 }} text="PRESSURE OUT" anchor="start" />
        </G>
      ) : null}
      {stage === 2 && massive ? (
        <G>
          <Burst at={centre} radius={64} />
          <Circle cx={centre.x} cy={centre.y} r={26} fill={CORE} opacity={0.5} />
          <Hole at={centre} radius={11} />
        </G>
      ) : null}
      {stage === 2 && !massive ? (
        <G>
          <Circle cx={centre.x} cy={centre.y} r={58} fill="none" stroke={GAS} strokeWidth={5} opacity={0.5} />
          <Circle
            cx={centre.x}
            cy={centre.y}
            r={40}
            fill="none"
            stroke={GAS}
            strokeWidth={3}
            strokeDasharray="4 4"
            opacity={0.7}
          />
          <Circle cx={centre.x} cy={centre.y} r={8} fill={WHITE_DWARF} stroke={INK} strokeWidth={OUTLINE} />
        </G>
      ) : null}
      <Label at={{ x: 160, y: 164 }} text={(massive ? CAPTIONS.massive : CAPTIONS.sunLike)[stage] ?? ''} bold />
      <Line x1={90} y1={180} x2={230} y2={180} stroke={INK} strokeWidth={1.6} />
      {STAGE_NAMES.map((name, index) => (
        <G key={name}>
          <Circle
            cx={90 + index * 70}
            cy={180}
            r={index === stage ? 6 : 4.5}
            fill={index === stage ? FOCUS : PAPER_DEEP}
            stroke={INK}
            strokeWidth={1.8}
          />
          <Label at={{ x: 90 + index * 70, y: 196 }} text={name} bold={index === stage} />
        </G>
      ))}
      {scene.focus === 'star' ? <FocusRing at={centre} radius={stage === 2 ? 72 : base + 10} /> : null}
      {scene.focus === 'core' ? <FocusRing at={centre} radius={stage === 2 ? 17 : core + 9} /> : null}
      {scene.focus === 'remnant' ? <FocusRing at={centre} radius={stage === 2 ? 24 : 15} /> : null}
    </G>
  );
}

/** Two black holes to scale, with the light near the edge of the marked one. */
function HorizonView({ scene }: { readonly scene: BlackHoleScene }) {
  const largeMarked = scene.largeMarked >= 0.5;
  const holes = [
    { at: { x: 62, y: 92 }, radius: scene.smallHolePx, marked: !largeMarked, name: 'SMALLER HOLE' },
    { at: { x: 190, y: 92 }, radius: scene.largeHolePx, marked: largeMarked, name: 'FOUR TIMES THE MASS' },
  ] as const;
  const target = holes[largeMarked ? 1 : 0];
  const outStart = { x: target.at.x + target.radius * 1.6, y: target.at.y };
  const outEnd = { x: outStart.x + 34, y: outStart.y };
  const inStart = { x: target.at.x + target.radius * 0.7, y: target.at.y };
  const inEnd = { x: target.at.x + target.radius * 0.15, y: target.at.y };
  return (
    <G>
      {holes.map((hole) => (
        <G key={hole.name}>
          <Hole at={hole.at} radius={hole.radius} />
          <Label at={{ x: hole.at.x, y: 174 }} text={hole.name} bold={hole.marked} />
          {hole.marked ? (
            <Polygon
              points={`${hole.at.x - 5},${hole.at.y - hole.radius - 14} ${hole.at.x + 5},${hole.at.y - hole.radius - 14} ${hole.at.x},${hole.at.y - hole.radius - 6}`}
              fill={FOCUS}
              stroke={INK}
              strokeWidth={1.4}
            />
          ) : null}
        </G>
      ))}
      <Line
        x1={target.at.x}
        y1={target.at.y}
        x2={target.at.x}
        y2={target.at.y - target.radius}
        stroke={PAPER}
        strokeWidth={1.6}
        strokeDasharray="3 3"
      />
      <Arrow from={outStart} to={outEnd} width={4} colour={BLUE} outlined />
      <Arrow from={inStart} to={inEnd} width={3} colour={PAPER} />
      <Label at={{ x: Math.min(outStart.x + 17, 250), y: outStart.y - 12 }} text="LIGHT CAN GET AWAY" />
      <Label at={{ x: Math.min(Math.max(target.at.x, 95), 225), y: 156 }} text="EVEN OUTWARD LIGHT FALLS IN" />
      <Label at={{ x: 160, y: 192 }} text="HORIZON RADIUS GOES WITH THE MASS · NOTHING IS DRAWN AT THE CENTRE" />
      {scene.focus === 'horizon' ? <FocusRing at={target.at} radius={target.radius + 7} /> : null}
      {scene.focus === 'light-out' ? <FocusBox x={outStart.x - 6} y={outStart.y - 14} width={46} height={28} /> : null}
      {scene.focus === 'light-in' ? (
        <FocusRing at={{ x: (inStart.x + inEnd.x) / 2, y: inStart.y }} radius={Math.max(8, target.radius * 0.45)} />
      ) : null}
    </G>
  );
}

/** A star and a black hole of the same mass, each pulling a faraway object with the same arrow. */
function PullView({ scene }: { readonly scene: BlackHoleScene }) {
  const star = { x: 46, y: 84 };
  const hole = { x: 206, y: 84 };
  const panel = (centre: Point, pull: number) => {
    const object = { x: centre.x + 84, y: centre.y };
    return (
      <G>
        <Circle cx={object.x} cy={object.y} r={4} fill={MUTED} stroke={INK} strokeWidth={1.6} />
        <Arrow
          from={{ x: object.x - 8, y: object.y }}
          to={{ x: object.x - 8 - PULL_ARROW_PX * pull, y: object.y }}
          width={4.5}
          colour={WARM}
          outlined
        />
      </G>
    );
  };
  return (
    <G>
      <Circle cx={star.x} cy={star.y} r={31} fill={SUN} opacity={0.28} />
      <Circle cx={star.x} cy={star.y} r={25} fill={SUN} stroke={INK} strokeWidth={OUTLINE} />
      <Hole at={hole} radius={6} />
      {panel(star, scene.starPull)}
      {panel(hole, scene.holePull)}
      <Line x1={160} y1={20} x2={160} y2={150} stroke={MUTED} strokeWidth={1.4} strokeDasharray="4 4" />
      <Label at={{ x: 80, y: 130 }} text="A STAR OF MASS M" bold />
      <Label at={{ x: 240, y: 130 }} text="A BLACK HOLE OF MASS M" bold />
      <Label at={{ x: 80, y: 36 }} text="PULL ON A FAR OBJECT" />
      <Label at={{ x: 240, y: 36 }} text="THE SAME PULL" />
      <Label at={{ x: 160, y: 168 }} text="FAR AWAY ONLY THE MASS AND THE DISTANCE MATTER" />
      <Label at={{ x: 160, y: 184 }} text="NOT TO SCALE: THE BLACK HOLE IS MUCH SMALLER THAN THE STAR" />
      {scene.focus === 'star' ? <FocusRing at={star} radius={36} /> : null}
      {scene.focus === 'hole' ? <FocusRing at={hole} radius={16} /> : null}
    </G>
  );
}

/** Stars on three orbits round a point where nothing shines. */
function OrbitsView({ scene }: { readonly scene: BlackHoleScene }) {
  const centre = { x: 160, y: 92 };
  return (
    <G>
      {scene.orbitPx.map((radius) => (
        <Circle
          key={radius}
          cx={centre.x}
          cy={centre.y}
          r={radius}
          fill="none"
          stroke={MUTED}
          strokeWidth={1.4}
          strokeDasharray="5 5"
        />
      ))}
      <Circle cx={centre.x} cy={centre.y} r={4} fill="none" stroke={MUTED} strokeWidth={1.6} strokeDasharray="2 2" />
      {scene.orbitPx.map((radius, index) => {
        const degrees = scene.orbitDegrees[index] ?? 0;
        const at = onCircle(centre, radius, degrees);
        const turn = (degrees * Math.PI) / 180;
        const length = scene.speedPx[index] ?? ORBIT_ARROW_PX;
        const to = { x: at.x - Math.sin(turn) * length, y: at.y - Math.cos(turn) * length };
        return (
          <G key={radius}>
            <Arrow from={at} to={to} width={3} colour={WARM} outlined />
            <Circle cx={at.x} cy={at.y} r={5} fill={SUN} stroke={INK} strokeWidth={1.8} />
            {scene.focus === 'stars' ? <FocusRing at={at} radius={11} /> : null}
          </G>
        );
      })}
      <Label at={{ x: 14, y: 16 }} text="ARROW: HOW FAST" anchor="start" />
      <Label at={{ x: 160, y: 190 }} text="NOTHING SHINES AT THE CENTRE · ORBITS DRAWN AS CIRCLES" />
      {scene.focus === 'centre' ? <FocusRing at={centre} radius={12} /> : null}
    </G>
  );
}

/** A tilted disc of gas round a black hole, hotter and bluer toward the middle, in false colour. */
function DiscView({ scene }: { readonly scene: BlackHoleScene }) {
  const centre = { x: 160, y: 88 };
  const bands = [...scene.ringPx.keys()].reverse();
  return (
    <G>
      {bands.map((band) => (
        <Path
          key={band}
          d={ringPath(centre, scene.ringPx[band] ?? 0, scene.ringInnerPx[band] ?? 0, DISC_FLATNESS)}
          fillRule="evenodd"
          fill={scene.ringColours[band]}
          stroke={INK}
          strokeWidth={1.4}
        />
      ))}
      <Hole at={centre} radius={scene.diskHolePx} />
      <Label at={{ x: 160, y: 22 }} text="GAS FALLING IN FORMS A DISC" bold />
      <Label at={{ x: 160, y: 152 }} text="THE BLACK HOLE ITSELF GIVES OUT NO LIGHT" />
      <Label at={{ x: 160, y: 170 }} text="FALSE COLOUR: HOTTER IS BLUER" bold />
      <Label at={{ x: 160, y: 184 }} text="THE HOT INNER GAS GLOWS IN X-RAYS, WHICH CANNOT BE SEEN" />
      {scene.focus === 'disc' ? <FocusBox x={centre.x - 102} y={centre.y - 44} width={204} height={88} /> : null}
      {scene.focus === 'hole' ? <FocusRing at={centre} radius={12} /> : null}
    </G>
  );
}

/** Two black holes spiralling together, and the ripples they make over time. */
function WavesView({ scene }: { readonly scene: BlackHoleScene }) {
  const centre = { x: 160, y: 50 };
  const merged = scene.merged >= 0.5;
  const turn = (scene.pairDegrees * Math.PI) / 180;
  const half = scene.separationPx / 2;
  const first = { x: centre.x + half * Math.cos(turn), y: centre.y - half * Math.sin(turn) };
  const second = { x: centre.x - half * Math.cos(turn), y: centre.y + half * Math.sin(turn) };
  const x = (index: number): number => WAVES.left + (index / (scene.wave.length - 1)) * (WAVES.right - WAVES.left);
  const point = (index: number): string =>
    `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(1)} ${(WAVES.baseline - (scene.wave[index] ?? 0) * WAVES.height).toFixed(1)}`;
  const reached = Math.round(scene.nowShare * (scene.wave.length - 1));
  const mergerX = WAVES.left + scene.mergerShare * (WAVES.right - WAVES.left);
  return (
    <G>
      {merged ? (
        <Hole at={centre} radius={17} />
      ) : (
        <G>
          <Hole at={first} radius={9} />
          <Hole at={second} radius={9} />
        </G>
      )}
      <Label at={{ x: 14, y: 16 }} text={merged ? 'ONE BLACK HOLE' : 'TWO BLACK HOLES'} anchor="start" bold />
      <Line x1={WAVES.left} y1={WAVES.baseline} x2={WAVES.right} y2={WAVES.baseline} stroke={INK} strokeWidth={1.4} />
      <Path
        d={scene.wave.map((_, index) => point(index)).join(' ')}
        fill="none"
        stroke={MUTED}
        strokeWidth={1.4}
        opacity={0.35}
      />
      <Path
        d={scene.wave
          .slice(0, Math.max(reached, 1) + 1)
          .map((_, index) => point(index))
          .join(' ')}
        fill="none"
        stroke={FOCUS}
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
      <Line
        x1={mergerX}
        y1={WAVES.baseline - 44}
        x2={mergerX}
        y2={WAVES.baseline + 22}
        stroke={MUTED}
        strokeWidth={1.4}
        strokeDasharray="3 3"
      />
      <Label at={{ x: mergerX, y: WAVES.baseline - 48 }} text="MERGER" />
      <Label at={{ x: WAVES.left, y: 110 }} text="WAVE STRENGTH, NOT TO SCALE" anchor="start" />
      <Label at={{ x: WAVES.right, y: 186 }} text="TIME →" anchor="end" />
      <Label at={{ x: WAVES.left, y: 186 }} text="RIPPLES IN SPACE ITSELF" anchor="start" bold />
      {scene.focus === 'holes' ? <FocusRing at={centre} radius={Math.max(half + 18, 24)} /> : null}
      {scene.focus === 'signal' ? (
        <FocusBox x={WAVES.left - 6} y={WAVES.baseline - 56} width={WAVES.right - WAVES.left + 12} height={84} />
      ) : null}
    </G>
  );
}

/** A bright ring of gas round a dark shadow, with the smaller horizon inside it. */
function ShadowView({ scene }: { readonly scene: BlackHoleScene }) {
  const centre = { x: 160, y: 98 };
  return (
    <G>
      <Path
        d={ringPath(centre, scene.shadowPx + 16, scene.shadowPx, 1)}
        fillRule="evenodd"
        fill={GLOW}
        stroke={INK}
        strokeWidth={1.6}
      />
      <Circle cx={centre.x} cy={centre.y} r={scene.shadowPx} fill={INK} />
      <Circle
        cx={centre.x}
        cy={centre.y}
        r={scene.shadowHorizonPx}
        fill="none"
        stroke={PAPER}
        strokeWidth={1.6}
        strokeDasharray="3 3"
      />
      <LightLabel at={{ x: centre.x, y: centre.y + 3 }} text="HORIZON" />
      <LightLabel at={{ x: centre.x, y: centre.y + scene.shadowPx - 12 }} text="SHADOW" />
      <Label at={{ x: 160, y: 12 }} text="BRIGHT RING: GLOWING GAS" bold />
      <Label at={{ x: 160, y: 190 }} text="THE SHADOW IS WIDER THAN THE HORIZON · NOT THE HORIZON ITSELF" />
      {scene.focus === 'ring' ? <FocusRing at={centre} radius={scene.shadowPx + 24} /> : null}
      {scene.focus === 'shadow' ? <FocusRing at={centre} radius={scene.shadowPx - 6} /> : null}
      {scene.focus === 'horizon' ? <FocusRing at={centre} radius={scene.shadowHorizonPx + 5} /> : null}
    </G>
  );
}

/** The kit's picture of one scene, filling the box it is given (its frame is 320 × 200). */
export function BlackHolePicture({ scene }: { readonly scene: BlackHoleScene }): ReactElement {
  return (
    <Svg width="100%" height="100%" viewBox={`0 0 ${SCENE_WIDTH} ${SCENE_HEIGHT}`} preserveAspectRatio="xMidYMid meet">
      {scene.view === 'formation' ? <FormationView scene={scene} /> : null}
      {scene.view === 'horizon' ? <HorizonView scene={scene} /> : null}
      {scene.view === 'pull' ? <PullView scene={scene} /> : null}
      {scene.view === 'orbits' ? <OrbitsView scene={scene} /> : null}
      {scene.view === 'disc' ? <DiscView scene={scene} /> : null}
      {scene.view === 'waves' ? <WavesView scene={scene} /> : null}
      {scene.view === 'shadow' ? <ShadowView scene={scene} /> : null}
    </Svg>
  );
}
