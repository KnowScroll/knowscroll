import { Circle, ClipPath, Defs, G, Path, RadialGradient, Stop } from 'react-native-svg';
import { space } from '@knowscroll/design-tokens';
import type { SceneGeometry } from '@knowscroll/scene-core';
import { BODY_COLOURS, calmColours, calmer, STAR_COLOUR } from './universe-palette';
import type { Vec } from './universe-layout';

/**
 * The small drawing kit of the formation story (U05): the new star and the new planet. Plain 2D
 * vector shapes computed from persisted descriptors; none of it encodes how much was watched or read.
 * The planet views (U03, U04) are drawn from the world generator instead (`planet/`).
 */
/** Closed path through the silhouette's vertices, scaled and turned about a centre. */
export function silhouettePath(geometry: SceneGeometry, centre: Vec, scale: number, turn = 0): string {
  const cos = Math.cos(turn),
    sin = Math.sin(turn);
  const points = geometry.silhouette.map((vertex) => {
    const x = vertex.x * scale,
      y = vertex.y * scale;
    return `${(centre.x + x * cos - y * sin).toFixed(2)},${(centre.y + x * sin + y * cos).toFixed(2)}`;
  });
  return `M ${points.join(' L ')} Z`;
}

const turnFromSeed = (seed: string) => (Number.parseInt(seed.slice(0, 4), 16) / 0xffff) * Math.PI * 2;

export interface PlanetGlyphProps {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly geometry: SceneGeometry;
  /** The seed of the descriptor; turns the land and sets the cloud lanes. */
  readonly seed: string;
  /** Quieter look for a place with no recent activity: same shape, less saturation, no glow. */
  readonly calm?: boolean;
  /** Low detail: a flat silhouette, no layered terraces, clouds or terminator. */
  readonly low?: boolean;
  /** Draws the shadowed side. Large close-ups only. */
  readonly terminator?: boolean;
}

/** A planet as ocean disc, layered land and rim, in the silhouette family the scene chose. */
export function PlanetGlyph({ cx, cy, r, geometry, seed, calm, low, terminator }: PlanetGlyphProps) {
  const colours = calm ? calmColours(BODY_COLOURS[geometry.palette]) : BODY_COLOURS[geometry.palette];
  const id = `ks-planet-${geometry.objectId}`;
  const scale = (r * 0.8) / geometry.radius;
  const turn = turnFromSeed(seed);
  const centre = { x: cx, y: cy };
  const layers = low
    ? ([[1, colours.land, 1]] as const)
    : ([
        [1, colours.land, 1.4],
        [0.74, colours.landMid, 1],
        [0.5, colours.landLight, 1],
        [0.28, colours.landCore, 1],
      ] as const);
  return (
    <G>
      <Defs>
        <RadialGradient id={`${id}-ocean`} cx="34%" cy="28%" r="80%">
          <Stop offset="0" stopColor={colours.oceanLight} />
          <Stop offset="0.55" stopColor={colours.oceanMid} />
          <Stop offset="1" stopColor={colours.oceanDeep} />
        </RadialGradient>
        <RadialGradient id={`${id}-glow`} cx="50%" cy="50%" r="50%">
          <Stop offset="0.76" stopColor={colours.glow} stopOpacity={0.24} />
          <Stop offset="1" stopColor={colours.glow} stopOpacity={0} />
        </RadialGradient>
        <ClipPath id={`${id}-clip`}>
          <Circle cx={cx} cy={cy} r={r} />
        </ClipPath>
      </Defs>
      {calm ? null : <Circle cx={cx} cy={cy} r={r * 1.3} fill={`url(#${id}-glow)`} />}
      <Circle cx={cx} cy={cy} r={r} fill={`url(#${id}-ocean)`} />
      <G clipPath={`url(#${id}-clip)`}>
        {layers.map(([factor, fill, strokeWidth]) => (
          <Path
            key={factor}
            d={silhouettePath(geometry, centre, scale * factor, turn)}
            fill={fill}
            stroke={colours.stroke}
            strokeOpacity={factor === 1 ? 1 : 0.3}
            strokeWidth={strokeWidth}
            strokeLinejoin="round"
          />
        ))}
        {low ? null : (
          <G fill="none" stroke="#FFFFFF" strokeLinecap="round" opacity={calm ? 0.5 : 1}>
            <Path
              d={`M ${cx - r * 0.7} ${cy - r * 0.2} q ${r * 0.28} ${-r * 0.1} ${r * 0.55} ${-r * 0.03} q ${r * 0.16} ${r * 0.04} ${r * 0.3} ${-r * 0.01}`}
              strokeOpacity={0.5}
              strokeWidth={Math.max(1.5, r * 0.03)}
            />
            <Path
              d={`M ${cx + r * 0.05} ${cy + r * 0.62} q ${r * 0.2} ${-r * 0.07} ${r * 0.47} ${-r * 0.01}`}
              strokeOpacity={0.4}
              strokeWidth={Math.max(1.2, r * 0.025)}
            />
          </G>
        )}
        {terminator && !calm ? (
          <Circle cx={cx + r * 1.3} cy={cy + r * 0.85} r={r * 1.5} fill={space.s0} opacity={0.22} />
        ) : null}
      </G>
      <Circle
        cx={cx}
        cy={cy}
        r={r + 0.5}
        fill="none"
        stroke={calm ? space.orbit : '#B8FFF4'}
        strokeOpacity={calm ? 1 : 0.5}
        strokeWidth={1.5}
      />
    </G>
  );
}

/** The organising star: a warm core with two soft halos. A calm star keeps its core, loses its halos. */
export function StarGlyph({ cx, cy, r, calm }: { cx: number; cy: number; r: number; calm?: boolean }) {
  return (
    <G>
      {calm ? null : (
        <>
          <Circle cx={cx} cy={cy} r={r * 2.7} fill={STAR_COLOUR} opacity={0.05} />
          <Circle cx={cx} cy={cy} r={r * 1.85} fill={STAR_COLOUR} opacity={0.1} />
        </>
      )}
      <Circle cx={cx} cy={cy} r={r} fill={calm ? calmer(STAR_COLOUR, 0.55) : STAR_COLOUR} />
    </G>
  );
}
