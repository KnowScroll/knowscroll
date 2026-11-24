import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';

/**
 * The stops of the Round 7.3 ladder that today's places fill, outermost first. One camera moves between them: each stop
 * is a distance from what you are in, not a separate screen. A level above a star (a galaxy, a cluster) is one more
 * entry here, between `universe` and `star`, with the kind of place that opens it.
 */
export const LADDER = ['universe', 'star', 'planet', 'ground'] as const;
export type Stop = (typeof LADDER)[number];

/**
 * The stop a view is at. The stored camera is unchanged from the Universe before 7.3: no focus is the whole universe, a
 * system is its star, a planet is the planet, and a landed planet or a chosen region is the ground.
 */
export function stopOf(view: UniverseView): Stop {
  if (view.kind === 'universe') return 'universe';
  if (view.kind === 'system') return 'star';
  return view.landed ? 'ground' : 'planet';
}

/** How deep a stop is: the universe is 0, the ground the deepest. */
export const depthOf = (stop: Stop): number => LADDER.indexOf(stop);

/**
 * One stop up the ladder: the ground climbs to its planet's globe, everything else to its parent (the Back pill's
 * `up` goes from a landed planet straight to its system, which skips a stop of the Round 7.3 ladder).
 */
export function climbOneStop(session: UniverseMapSession, view: UniverseView): void {
  if (view.kind === 'planet' && view.landed && view.selectedRegion === undefined) {
    void session.focus(view.planet.objectId);
    return;
  }
  void session.up();
}
