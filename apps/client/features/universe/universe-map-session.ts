import type {
  AvailableRegionPreview,
  createFormationPresentationSession,
  RegionPreviewState,
  UniverseSceneState,
} from '@knowscroll/client-core';
import type { SceneDescriptor, SceneGeometry, SceneLook } from '@knowscroll/scene-core';
import type { TransitionGate } from './animation/transition-gate';
import type { UniverseFrame } from './universe-camera';
import type { CameraEntry } from './universe-camera-history';
import type { CollectionState } from './universe-collection-reader';
import type { DustState } from './universe-dust';
import type { LastPlace } from './universe-memory';
import type { UniversePlace } from './universe-places';

export interface UniverseViewState extends CameraEntry {
  /** On a planet: its landed map (U04) is showing instead of its globe (U03). A focused region is always landed. */
  readonly landed: boolean;
  readonly read: UniverseSceneState;
  /** `collection` is the landmarks sheet (D-084); `finds` is the focused system's Reels and Scrolls (#697). */
  readonly overlay: 'outline' | 'place' | 'search' | 'collection' | 'finds' | 'settings' | null;
  readonly detail: 'full' | 'low';
  readonly reducedMotion: boolean;
  readonly notice?: 'place_unavailable';
  readonly historyDepth: number;
  readonly regionPreview: RegionPreviewState;
  /** The Lately lens: quiet places draw calm, and the list puts recent ones first. Per device. */
  readonly lately: boolean;
  readonly dust: DustState;
  /** The person's own landmarks, Orbit and next Part. Always empty for a friend's universe (D-214). */
  readonly collection: CollectionState;
  /** Where the ship is parked: the last place flown to on this device. */
  readonly lastPlace: LastPlace | undefined;
  /** Away long enough that the camera starts framed on everything, with the ship at its last place. */
  readonly absent: boolean;
  /** A system picked on the map but not entered yet (second tap or Open enters it). */
  readonly selectedId: string | null;
  /**
   * The looks to draw when they do not come from a scene read: a friend's visit derives its own on this device
   * (D-114). Absent on the person's own map, whose looks are the server's (D-102).
   */
  readonly looks?: readonly SceneLook[];
  /** U04: the region the person left through its card's Open, private to this device, until they choose it again. */
  readonly youWereHere: string | null;
  /** The system whose Reels and Scrolls the `finds` sheet lists (#697). */
  readonly findsFor: string | null;
  /** The landmark the person already looked at or put away on this device: its large card stays folded (#694). */
  readonly seenLandmark: string | null;
}

/** The formation story's session, as the person's own map builds it. */
export type UniverseFormationSession = ReturnType<typeof createFormationPresentationSession>;

/**
 * What the map is drawn from, and what every drawing calls: one camera over a list of places, with a Back history, a
 * selection and the sheets. The person's own universe and a friend's (U06) both give it. A friend's has no formation story,
 * so that part is not something the drawing needs (see `UniverseViewSession`). Each member says what the person's own map
 * does; a friend's map (`createVisitMapSession`) answers the ones that belong only to your own universe with a no-op or `false`.
 */
export interface UniverseMapSession {
  /** The camera, the selection, the sheet and the read, as of now: a new object after every change. */
  readonly getState: () => UniverseViewState;
  /** Calls `listener` after each change; returns the way to stop. Once the session has ended it returns a no-op. */
  readonly subscribe: (this: void, listener: () => void) => () => void;
  /** The places on the map, as ids, parents, kinds, labels and truth. */
  readonly places: () => readonly UniversePlace[];
  /** The scene descriptors the places are drawn from. A drawing may ask for geometry only of one of these. */
  readonly descriptors: () => readonly SceneDescriptor[];
  /**
   * Flies to a place. It adds a Back step, except between places that replace each other (regions of one planet on
   * your own map, planets of one system on a friend's). `land` on a planet goes straight to its map. False when the
   * place is not on the map.
   */
  readonly focus: (id: string, options?: { readonly land?: boolean }) => boolean;
  /** One step back: closes a sheet, then a pick, then returns to the previous camera. False when there is nothing to go back to. */
  readonly back: () => boolean;
  /** Whether `back` has anything to do. */
  readonly canBack: () => boolean;
  /** Tells the session whether its screen is showing; nothing moves while it is not. */
  readonly setForeground: (value: boolean) => void;
  /** Sets the drawing detail and whether motion is reduced; the drawings are rebuilt only when one changed. */
  readonly configure: (next: { detail: 'full' | 'low'; reducedMotion: boolean }) => void;
  /** Simple drawing on or off: the map as plain lists. */
  readonly setSimple: (simple: boolean) => void;
  /** Opens a sheet, or closes the open one with `null`. */
  readonly showOverlay: (overlay: UniverseViewState['overlay']) => void;
  /** Opens the sheet of a system's Reels and Scrolls. */
  readonly showFinds: (systemId: string) => void;
  /** Records that the landmark's large card was looked at, so it stays folded. */
  readonly seeLandmark: (landmarkId: string) => void;
  /** The systems the drawing shows in detail now: their planets are loaded, the others may be let go of. */
  readonly setDetail: (systemIds: readonly string[]) => void;
  /** Systems a list or the dial is open on, held while they are listed; `[]` lets them go. */
  readonly keepSystems: (systemIds: readonly string[]) => void;
  /** Reads the focused region's preview again. */
  readonly refreshRegionPreview: () => void;
  /** Opens the displayed region card's encounter, or with `choice` its other format. False when it cannot open. */
  readonly openRegion: (
    displayed: AvailableRegionPreview,
    onReturn: () => void,
    choice?: 'encounter' | 'alternate',
  ) => boolean;
  /** Moves the camera to `frame`, kept within the bounds of the view. */
  readonly camera: (frame: UniverseFrame) => void;
  /** Frames the current view as the screen first draws it. */
  readonly fit: () => void;
  /** Turns the Lately lens on or off. */
  readonly setLately: (lately: boolean) => void;
  /** Picks a place on the map without entering it; `null` clears the pick. */
  readonly select: (id: string | null) => void;
  /** Steps up one level: from a planet to its system, from a system to the whole universe. */
  readonly up: () => boolean;
  /** Closes what is open (a sheet, a pick) and with nothing open steps up. False on the whole map. */
  readonly escape: () => boolean;
  /** Lands on the planet in focus, so its map shows instead of its globe. False when there is no planet to land on. */
  readonly land: () => boolean;
  /** Flies to the place the ship is parked at. False when there is none or it is already in focus. */
  readonly focusLast: () => boolean;
  /** Reads the map again from the server. */
  readonly refresh: () => Promise<void>;
  /** Follows a Cartographer route to its other end. False when the route is not known. */
  readonly travel: (routeId: string) => boolean;
  /** The drawing of a place of the current list, built once and kept; `low` asks for the plain drawing. */
  readonly geometry: (object: SceneDescriptor, low?: boolean) => SceneGeometry | undefined;
  /** How many drawings are kept. */
  readonly cacheSize: () => number;
  /** How far the whole-universe view may zoom in, set by the drawing from the extent of the map. */
  readonly setZoomMax: (max: number) => void;
  /** Whether an animation is playing, and the way for the screen to register how to finish it. */
  readonly gate: TransitionGate;
}

/** The person's own map: a map session and the formation story shown over it. */
export interface UniverseViewSession extends UniverseMapSession {
  /** The story of how the universe grew since the person last looked. */
  readonly formation: UniverseFormationSession;
  /** Puts the story away, flying to its target, if the story shown is still the one named. */
  readonly dismissFormation: (expected?: Parameters<UniverseFormationSession['dismiss']>[0]) => void;
}
