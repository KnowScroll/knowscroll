/**
 * The ladder of stops one camera moves along, and the pure rules that read a place on it. The voyage reads the stop
 * from the stored camera (`stopOf`), names where it is going (`targetOf`, `targetKey`), looks up what each stop shows
 * (`STOPS`) and says which way the Back pill climbs (`climbOneStop`). Kept free of three.js, so the controller and the
 * header, which reach the main bundle, may import it.
 */
import type { SpaceAnchor } from '../space/space-surface';
import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession, UniverseViewSession } from '../universe-session';
/**
 * The stops of the ladder that today's places fill, outermost first. One camera moves between them: each stop is a
 * distance from what you are in, not a separate screen. The prototype's names for `star` and `ground` are `system` and
 * `surface`. A level above a star (a galaxy, a cluster) is one more member here and one more row of {@link STOPS},
 * between `universe` and `star`; the camera's chain of places (`voyage-chains.ts`) then gains its link after the star's,
 * and the session the kind of place that opens it.
 */
export type Stop = 'universe' | 'star' | 'planet' | 'ground';

/** What a stop shows, wherever it is drawn. */
export interface StopSpec {
  /**
   * Where the stop holds what it looks at, as a share of the view's height from the top (the prototype's `anchorY`):
   * above the middle on a phone, so the chips at the bottom never cover it.
   */
  readonly heldAt: number;
  /** The kinds of place the stop gives a named button: the systems from afar, a star's planets, a planet's regions. */
  readonly names: readonly SpaceAnchor['kind'][];
  /**
   * The kinds whose name is also written beside them. From afar a room's name would crowd its star's, so there it is
   * only its button's, for a screen reader.
   */
  readonly written: readonly SpaceAnchor['kind'][];
}

/** The ladder as data: one row per stop. Stations and dust are named where they are, beside their star. */
export const STOPS: Readonly<Record<Stop, StopSpec>> = {
  universe: { heldAt: 0.455, names: ['system', 'station', 'dust'], written: ['system'] },
  star: { heldAt: 0.5, names: ['planet', 'station', 'dust'], written: ['planet', 'station'] },
  planet: { heldAt: 0.415, names: ['region'], written: ['region'] },
  ground: { heldAt: 0.45, names: ['region'], written: ['region'] },
};

/** Where the person is going: a stop of the ladder and the places that make it. */
export interface VoyageTarget {
  readonly stop: Stop;
  /** The star the place is at or in; null for the whole universe. */
  readonly systemId: string | null;
  /** The planet the place is at or in; null at a star or the whole universe. */
  readonly planetId: string | null;
  /** A chosen region on the ground: the camera comes down over it. */
  readonly regionId: string | null;
}

/**
 * The stop a view is at. The stored camera is the one the Universe had before the voyage: no focus is the whole
 * universe, a system is its star, a planet is the planet, and a landed planet or a chosen region is the ground.
 */
export function stopOf(view: UniverseView): Stop {
  if (view.kind === 'universe') return 'universe';
  if (view.kind === 'system') return 'star';
  return view.landed ? 'ground' : 'planet';
}

/** Where a view of the map is on the ladder: the stop, and the star, planet and region that make it. */
export function targetOf(view: UniverseView): VoyageTarget {
  if (view.kind === 'universe') return { stop: 'universe', systemId: null, planetId: null, regionId: null };
  if (view.kind === 'system') return { stop: 'star', systemId: view.system.objectId, planetId: null, regionId: null };
  return {
    stop: stopOf(view),
    systemId: view.planet.parentId,
    planetId: view.planet.objectId,
    regionId: view.selectedRegion?.objectId ?? null,
  };
}

/**
 * A string that is the same for two targets that are the same place and differs for any two that are not. Lets a
 * caller notice "the target changed" without comparing four fields.
 */
export function targetKey(target: VoyageTarget): string {
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
 * `up` goes from a landed planet straight to its system, which would skip the planet stop. Returns whether it moved.
 */
export function climbOneStop(session: UniverseMapSession, view: UniverseView): boolean {
  if (view.kind === 'planet' && climbsToGlobe(view)) return session.focus(view.planet.objectId);
  return session.up();
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
