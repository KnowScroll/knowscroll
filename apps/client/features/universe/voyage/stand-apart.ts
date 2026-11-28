/**
 * Which things of the Universe's trial look stand apart on screen, as numbers: a room's station is never drawn over or
 * touching a sun (or a station beside it), and a cloud of forming dust never over a sun or a station. Pure and in screen
 * points, so the scene part (`stand-apart-scene.ts`) only measures and moves.
 *
 * Every body keeps its place in the scene; what is solved is an offset on screen. Each is pushed away from what it
 * overlaps along the line between their centres, which is a continuous function of where the camera is: a body slides
 * out as another comes near and slides back as it goes, and never jumps.
 */

/** The gap left between two discs that were pushed apart, in points. */
export const STAND_APART_GAP = 12;
/** Sweeps over the constraints. Pushing clear of one body can push a body into another, so the sweep repeats. */
const SWEEPS = 16;
/** Two centres nearer than this have no line between them: the push goes this way (to the right). */
const NO_LINE = 1e-6;
/** A pushed station keeps this far inside the edge of the view, in points. */
const EDGE_MARGIN = 8;

/** A disc on screen: its centre and radius, in points. */
export interface Disc {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** A system, as the suns and stations see it: its sun's disc and the disc its group of planets reaches. */
export interface SunDisc extends Disc {
  readonly systemId: string;
  /** The radius of its farthest planet's orbit on screen (a lone star's, as its glow). */
  readonly reach: number;
}

/** A station's drawn disc and the system it stands beside. */
export interface StationDisc extends Disc {
  readonly systemId: string;
}

/** What a station keeps clear of at its own system: the sun's disc, or the whole group's reach. */
export type StationClears = 'sun' | 'group';

export interface Standing {
  readonly suns: readonly SunDisc[];
  readonly stations: readonly StationDisc[];
  readonly dust: readonly Disc[];
  readonly stationClears: StationClears;
  /** The view, in points: a push never carries a station farther out of it than it stood. Absent: no edge. */
  readonly view?: { readonly width: number; readonly height: number };
}

/** How far to move on screen, in points, to stand apart. */
export interface Offset {
  readonly x: number;
  readonly y: number;
}

/** A body's place while it is being pushed. */
interface Place {
  x: number;
  y: number;
}

/**
 * Moves `place` (of `radius`) away from the disc at `(x, y)` of radius `from` along the line between their centres,
 * until the two stand a gap apart; it takes `share` of that move (the other disc takes the rest, if it moves too).
 */
function pushClear(place: Place, radius: number, x: number, y: number, from: number, share = 1): void {
  const need = radius + from + STAND_APART_GAP;
  const dx = place.x - x;
  const dy = place.y - y;
  const distance = Math.hypot(dx, dy);
  if (distance >= need) return;
  const [ux, uy] = distance < NO_LINE ? [1, 0] : [dx / distance, dy / distance];
  const move = (need - distance) * share;
  place.x += ux * move;
  place.y += uy * move;
}

/**
 * Holds `place` (a station that stood at `stood`, of its radius) inside the view, `EDGE_MARGIN` in from its edge, but
 * never nearer the middle than the station stood: a station whose system is off the edge stays off it with its system.
 * The bound moves with where it stood, so it never jumps as the camera moves.
 */
function keepInView(place: Place, stood: Disc, view: { readonly width: number; readonly height: number }): void {
  const inset = stood.radius + EDGE_MARGIN;
  place.x = Math.min(Math.max(place.x, Math.min(inset, stood.x)), Math.max(view.width - inset, stood.x));
  place.y = Math.min(Math.max(place.y, Math.min(inset, stood.y)), Math.max(view.height - inset, stood.y));
}

/**
 * The offsets, in the order of `stations` and `dust`, that stand apart: each station clears every sun's disc (its own
 * system's group too, for `'group'`) and the other stations; each cloud clears every sun's disc and every station, the
 * stations as moved. Nothing moves that is clear.
 */
export function standApart({ suns, stations, dust, stationClears, view }: Standing): {
  readonly stations: readonly Offset[];
  readonly dust: readonly Offset[];
} {
  const stationAt: Place[] = stations.map(({ x, y }) => ({ x, y }));
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    // Two stations take half of the push each, so which of them is first makes no difference.
    for (let a = 0; a < stations.length; a++)
      for (let b = a + 1; b < stations.length; b++) {
        const first = stationAt[a]!;
        const second = stationAt[b]!;
        const [x, y] = [second.x, second.y];
        pushClear(second, stations[b]!.radius, first.x, first.y, stations[a]!.radius, 0.5);
        pushClear(first, stations[a]!.radius, x, y, stations[b]!.radius, 0.5);
      }
    // The suns are cleared last in a sweep, so a sun is the one thing that is never left overlapped.
    stationAt.forEach((place, index) => {
      const station = stations[index]!;
      for (const sun of suns) {
        const reach = stationClears === 'group' && sun.systemId === station.systemId ? sun.reach : sun.radius;
        pushClear(place, station.radius, sun.x, sun.y, reach);
      }
      // Held inside the view, the next sweep's push slides a station along the edge instead of out over it.
      if (view !== undefined) keepInView(place, station, view);
    });
  }

  const dustAt: Place[] = dust.map(({ x, y }) => ({ x, y }));
  for (let sweep = 0; sweep < SWEEPS; sweep++)
    dustAt.forEach((place, index) => {
      const { radius } = dust[index]!;
      stationAt.forEach((moved, station) => pushClear(place, radius, moved.x, moved.y, stations[station]!.radius));
      for (const sun of suns) pushClear(place, radius, sun.x, sun.y, sun.radius);
    });

  return {
    stations: stationAt.map((place, index) => ({ x: place.x - stations[index]!.x, y: place.y - stations[index]!.y })),
    dust: dustAt.map((place, index) => ({ x: place.x - dust[index]!.x, y: place.y - dust[index]!.y })),
  };
}
