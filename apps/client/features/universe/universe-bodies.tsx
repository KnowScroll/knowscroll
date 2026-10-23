import { Circle, ClipPath, Defs, Ellipse, G, Path, Polygon, RadialGradient, Rect, Stop } from 'react-native-svg';
import { content, space } from '@knowscroll/design-tokens';
import type { SceneGeometry } from '@knowscroll/scene-core';
import { BODY_COLOURS, calmColours, calmer, STAR_COLOUR } from './universe-palette';
import { unitsFromId, type Vec } from './universe-layout';

/**
 * The layered-SVG drawing kit of the Universe (D-026): stars, planets, orbit hairlines, region
 * pins, dust and the ship. Everything is plain 2D vector shapes computed from persisted
 * descriptors; none of it encodes how much was watched or read.
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
        {terminator && !calm ? <Circle cx={cx + r * 1.3} cy={cy + r * 0.85} r={r * 1.5} fill={space.s0} opacity={0.22} /> : null}
      </G>
      <Circle cx={cx} cy={cy} r={r + 0.5} fill="none" stroke={calm ? space.orbit : '#B8FFF4'} strokeOpacity={calm ? 1 : 0.5} strokeWidth={1.5} />
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

/** An orbit hairline: decoration only. */
export function OrbitRing({ cx, cy, rx, ry, calm }: { cx: number; cy: number; rx: number; ry: number; calm?: boolean }) {
  return (
    <Ellipse cx={cx} cy={cy} rx={rx} ry={ry} fill="none" stroke={content.paper} strokeOpacity={calm ? 0.1 : 0.18} strokeWidth={1.2} />
  );
}

/** A region pin: an octagon with a centre dot, yellow when selected. */
export function RegionPin({ x, y, selected, size = 11 }: { x: number; y: number; selected?: boolean; size?: number }) {
  const corners = Array.from({ length: 8 }, (_, index) => {
    const angle = (Math.PI / 4) * index + Math.PI / 8;
    return `${(x + Math.cos(angle) * size).toFixed(2)},${(y + Math.sin(angle) * size).toFixed(2)}`;
  }).join(' ');
  return (
    <G>
      {selected ? <Circle cx={x} cy={y} r={size * 2} fill={space.regionPin.selected} opacity={0.28} /> : null}
      <Polygon
        points={corners}
        fill={selected ? space.regionPin.selected : space.regionPin.fill}
        stroke={space.regionPin.stroke}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <Circle cx={x} cy={y} r={size * 0.25} fill={space.regionPin.stroke} />
    </G>
  );
}

/** Dust: unlabelled gathering that is not a place yet. With `lone` it reads as a protostar. */
export function DustGlyph({ cx, cy, r, id, lone }: { cx: number; cy: number; r: number; id: string; lone?: boolean }) {
  const [phase] = unitsFromId(id);
  const specks = Array.from({ length: 7 }, (_, index) => {
    const angle = phase * Math.PI * 2 + index * 2.4;
    const distance = r * (0.18 + ((index * 37) % 10) / 16);
    return { x: cx + Math.cos(angle) * distance, y: cy + Math.sin(angle) * distance, size: 1 + (index % 3) * 0.5 };
  });
  return (
    <G>
      <Circle cx={cx} cy={cy} r={r} fill="#0E3A3F" opacity={lone ? 0.55 : 0.4} />
      <Circle cx={cx} cy={cy} r={r * 0.66} fill="#12525A" opacity={0.35} />
      {lone ? <Circle cx={cx} cy={cy} r={r * 0.9} fill="none" stroke={content.paper} strokeOpacity={0.35} strokeDasharray="2 6" strokeLinecap="round" /> : null}
      {specks.map((speck, index) => (
        <Circle key={index} cx={speck.x} cy={speck.y} r={speck.size} fill={content.paper} opacity={0.55} />
      ))}
      {lone ? (
        <>
          <Circle cx={cx} cy={cy} r={9} fill={STAR_COLOUR} opacity={0.18} />
          <Circle cx={cx} cy={cy} r={4.5} fill={STAR_COLOUR} />
        </>
      ) : null}
    </G>
  );
}

/** The ship: parked at the last place visited, with a short dotted trail behind it. */
export function ShipGlyph({ x, y }: { x: number; y: number }) {
  return (
    <G>
      <Path
        d={`M ${x - 44} ${y + 64} Q ${x - 34} ${y + 22} ${x - 8} ${y + 4}`}
        fill="none"
        stroke={space.focus}
        strokeWidth={1.6}
        strokeDasharray="2 6"
        strokeLinecap="round"
      />
      <Path d={`M ${x - 12} ${y - 10} l 20 2 -12 16 z`} fill={content.paper} />
    </G>
  );
}

export type LandmarkKind = 'lighthouse' | 'harbour';

/**
 * Decoration beside a region, picked from the planet's stable seed. A landmark names nothing and
 * never encodes how much was read; it only makes a place look inhabited.
 */
export function LandmarkGlyph({ x, y, kind }: { x: number; y: number; kind: LandmarkKind }) {
  if (kind === 'lighthouse')
    return (
      <G>
        <Path d={`M ${x - 3} ${y + 8} L ${x - 2} ${y - 6} L ${x + 2} ${y - 6} L ${x + 3} ${y + 8} Z`} fill={content.paper} stroke={content.ink} strokeWidth={1} />
        <Rect x={x - 3} y={y - 10} width={6} height={4} fill={space.focus} />
        <Path d={`M ${x + 3} ${y - 8} L ${x + 22} ${y - 16} M ${x + 3} ${y - 8} L ${x + 22} ${y - 2}`} stroke={space.focus} strokeOpacity={0.75} strokeWidth={1.5} />
      </G>
    );
  return (
    <G stroke={content.paper} strokeWidth={1.6} fill="none">
      <Path d={`M ${x - 8} ${y} h 16 M ${x - 4} ${y} v 6 M ${x + 4} ${y} v 6`} />
      <Path d={`M ${x - 15} ${y + 9} l 6 -7 2 7 z`} fill={content.paper} />
    </G>
  );
}
