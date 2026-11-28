/**
 * The level rail: the column of stops at the right edge that says where you are on the ladder and goes to any stop you
 * can reach from here (the design prototype's `rail`, `Universe.dc.html`). Pure: which stops it lists, and what going
 * to one asks of the session. The picture is `level-rail.tsx`.
 */
import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';
import type { Stop } from './ladder';

/** A stop the rail lists, outermost first. */
export interface RailStop {
  readonly stop: Stop;
  /** Its name: written beside the current stop's dot, and in every button's label ("Go to Planet"). */
  readonly name: string;
  readonly current: boolean;
}

/** The prototype's names for the stops. A level above a star (a galaxy) is one more row here, between Universe and Star. */
const NAMES: Readonly<Record<Stop, string>> = {
  outer: 'Other universes',
  universe: 'Universe',
  star: 'Star',
  planet: 'Planet',
  ground: 'Ground',
};

const ORDER: readonly Stop[] = ['outer', 'universe', 'star', 'planet', 'ground'];

/** What the screen allows beyond the ladder itself. */
export interface RailReach {
  /** Your own Universe has friends' universes past its rim (the outer stop); a friend's never does. */
  readonly otherUniverses: boolean;
  /** A planet you are at can be landed on: your own; a visitor never lands on a friend's planet. */
  readonly ground: boolean;
}

/**
 * The stops the rail lists at `at`: other universes (your own Universe only) and the whole universe always; the star
 * once you are at it or below; the planet once you are at it or below; the ground once you are at a planet you may land
 * on, or on it. Nothing above a star until there are levels there to go to.
 */
export function railOf(at: Stop, reach: RailReach): RailStop[] {
  const depth = ORDER.indexOf(at);
  const listed = (stop: Stop): boolean => {
    switch (stop) {
      case 'outer':
        return reach.otherUniverses;
      case 'universe':
        return true;
      case 'star':
        return depth >= ORDER.indexOf('star');
      case 'planet':
        return depth >= ORDER.indexOf('planet');
      case 'ground':
        return at === 'ground' || (at === 'planet' && reach.ground);
    }
  };
  return ORDER.filter(listed).map((stop) => ({ stop, name: NAMES[stop], current: stop === at }));
}

/** The outer stop's own switch, as the rail needs it. */
export interface OuterSwitch {
  readonly enter: () => void;
  readonly leave: () => void;
}

/**
 * Goes to `stop` from `view`, as one flight: the camera flies from where it is to there. Up the ladder it climbs a
 * level at a time in the session, so Back comes down the way the rail went up; down it goes straight to the star or
 * the planet the view is in, and lands on a planet for the ground. Returns whether anything moved.
 */
export function goToStop(
  session: Pick<UniverseMapSession, 'focus' | 'land' | 'up'>,
  view: UniverseView,
  at: Stop,
  stop: Stop,
  outer: OuterSwitch | null,
): boolean {
  if (stop === at) return false;
  switch (stop) {
    case 'outer': {
      if (outer === null) return false;
      climbToUniverse(session, view);
      outer.enter();
      return true;
    }
    case 'universe':
      if (at === 'outer') {
        outer?.leave();
        return outer !== null;
      }
      return climbToUniverse(session, view);
    case 'star':
      return view.kind === 'planet' ? session.focus(view.planet.parentId) : false;
    case 'planet':
      return view.kind === 'planet' ? session.focus(view.planet.objectId) : false;
    case 'ground':
      return view.kind === 'planet' && !view.landed ? session.land() : false;
  }
}

/** Climbs the session to the whole universe, a level at a time. Returns whether it moved. */
function climbToUniverse(session: Pick<UniverseMapSession, 'up'>, view: UniverseView): boolean {
  // A region climbs to its planet's ground, the ground to its star, a star to the universe: three at most.
  const levels = view.kind === 'universe' ? 0 : view.kind === 'system' ? 1 : view.selectedRegion ? 3 : 2;
  let moved = false;
  for (let level = 0; level < levels; level += 1) moved = session.up() || moved;
  return moved;
}
