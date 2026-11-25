/**
 * The ladder of stops one camera moves along, and the pure rules that read a place on it. The voyage reads the stop
 * from the stored camera (`stopOf`), names where it is going (`targetKey`) and says which way the Back pill climbs
 * (`climbOneStop`). Kept free of three.js, so the controller and the header, which reach the main bundle, may import it.
 */
import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession, UniverseViewSession } from '../universe-session';
/**
 * The stops of the ladder that today's places fill, outermost first. One camera moves between them: each stop is a
 * distance from what you are in, not a separate screen. A level above a star (a galaxy, a cluster) is one more member
 * here, between `universe` and `star`, with the kind of place that opens it. The prototype's names for `star` and
 * `ground` are `system` and `surface`.
 */
export type Stop = 'universe' | 'star' | 'planet' | 'ground';

/**
 * The stop a view is at. The stored camera is the one the Universe had before the voyage: no focus is the whole
 * universe, a system is its star, a planet is the planet, and a landed planet or a chosen region is the ground.
 */
export function stopOf(view: UniverseView): Stop {
  if (view.kind === 'universe') return 'universe';
  if (view.kind === 'system') return 'star';
  return view.landed ? 'ground' : 'planet';
}

/**
 * A string that is the same for two targets that are the same place and differs for any two that are not. Lets a
 * caller notice "the target changed" without comparing four fields.
 */
export function targetKey(target: {
  readonly stop: Stop;
  readonly systemId: string | null;
  readonly planetId: string | null;
  readonly regionId: string | null;
}): string {
  return `${target.stop}|${target.systemId ?? ''}|${target.planetId ?? ''}|${target.regionId ?? ''}`;
}

/**
 * True on the ground of a whole planet, with no region chosen: one step up is that planet's globe, not its star. A
 * chosen region climbs to the ground first (`selectedRegion`), so this is false for it.
 */
export function climbsToGlobe(view: UniverseView): boolean {
  return view.kind === 'planet' && view.landed && view.selectedRegion === undefined;
}

/**
 * One stop up the ladder: the ground climbs to its planet's globe, everything else to its parent. The Back pill's
 * `up` goes from a landed planet straight to its system, which would skip the planet stop.
 */
export function climbOneStop(session: UniverseMapSession, view: UniverseView): void {
  if (view.kind === 'planet' && climbsToGlobe(view)) {
    void session.focus(view.planet.objectId);
    return;
  }
  void session.up();
}

/**
 * Escape in the new look. The Universe's own Escape closes what is open (the formation story, a sheet, a card, a pick)
 * and otherwise goes up a level; on the ground with nothing open the new look climbs to the planet's globe instead, as
 * its Back pill does, where going up would skip that stop. Like the session's own `escape`, it does nothing while the
 * Universe is not in front, and returns whether the key did something.
 */
export function escapeOneStop(
  session: Pick<UniverseViewSession, 'escape' | 'focus' | 'formation' | 'getState' | 'places'>,
): boolean {
  const state = session.getState();
  const open = Boolean(session.formation.getState().fact) || state.overlay !== null || state.selectedId !== null;
  const focused = state.focusId === null ? undefined : session.places().find((place) => place.id === state.focusId);
  if (open || !state.landed || focused?.kind !== 'planet') return session.escape();
  return session.focus(focused.id);
}
