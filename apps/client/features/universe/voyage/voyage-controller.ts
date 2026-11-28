/**
 * What the trial's stage changes from frame to frame and touch to touch, outside React, and the pure rules it follows:
 * the driver's control (`VoyageControl`), the ship's motion (`ship-motion.ts`) and the stage's own gestures. It reaches
 * the main bundle, so it holds no three.js: the driver comes in on demand through `voyage-loader.ts`. Where a number
 * below copies the design prototype (`Universe.dc.html`, Round 7.3) it names the prototype's own constant.
 */
import { PanResponder, type GestureResponderEvent, type PanResponderInstance } from 'react-native';
import type { FlightLeg } from '../frame-rate/frame-meter';
import type { RigFocus } from '../space/camera-rig';
import type { loadSpaceRenderer } from '../space/load-space-renderer';
import type { SpaceAnchor } from '../space/space-surface';
import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';
import { bareTapOf } from './bare-tap';
import { createFlightLegs } from './flight-legs';
import type { Disc, Point } from './outer/friend-field';
import type { OuterStop } from './outer/outer-stop';
import { createPinchGesture, PINCH_STEP } from './pinch-gesture';
import { groundHome, NOWHERE, standsOf, type Stands } from './ground-home';
import { climbOneStop, targetKey, type VoyageTarget } from './ladder';
import { PLACE_PULL, pullOf } from './ship-gravity';
import { footOf } from './ship-ground';
import {
  arrival,
  drawn,
  HOLD_CAPTURE_SECONDS,
  initialShip,
  landShip,
  parkingSpot,
  pickShip,
  releaseShip,
  stepShip,
  takenFromFinger,
  type DrawnShip,
  type ShipHome,
  type ShipTarget,
  recentreShip,
  type ShipState,
} from './ship-motion';
import { createStageTouches, type Finger, type StageGesture } from './stage-touches';
import type { FallIn, UniverseOnScreen, VoyageControl, VoyageFrame, VoyagePlanet } from './voyage-control';
import { loadVoyageRenderer } from './voyage-loader';

/** A drag has to move this far before it turns the view; a shorter press is a tap on whatever is under it. */
const DRAG_START = 8;
/**
 * Where the ship parks, where the view leans from and how far it may go, for each layout (the prototype's `DESK`
 * branches in its ship code). A phone keeps it clear of the header above and the chips below; a desktop has neither.
 */
export const SHIP_LAYOUT = {
  phone: { parkAt: 0.675, leanCentre: 0.56, margins: { side: 26, top: 150, bottom: 204 } },
  desktop: { parkAt: 0.8, leanCentre: 0.6, margins: { side: 26, top: 70, bottom: 60 } },
} as const;

/** The ship's layout: the desktop's when the screen is on the product's desktop layout. */
export const shipLayoutOf = (desktop: boolean) => (desktop ? SHIP_LAYOUT.desktop : SHIP_LAYOUT.phone);
/** A wheel moves one stop, then waits this long before it moves another (the prototype's 260 ms `settle` timer). */
const WHEEL_REST_MS = 260;
/**
 * The keys that fly the ship, and which way: W A S D, as games use them, since the arrows turn the view. The prototype
 * has no key for the ship; a person who cannot drag needs one.
 */
const SHIP_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  w: [0, -1],
  a: [-1, 0],
  s: [0, 1],
  d: [1, 0],
};
/**
 * A press this soon after a finger last took the ship, turned the land or pinched is the end of that gesture, not a tap on
 * bare ground: a browser sends a click when a pointer is lifted over the element it went down on, even after a drag.
 */
const AFTER_GESTURE_MS = 350;
/** The key that opens the map of the whole planet, at the ground. */
const MAP_KEY = 'm';
/** Each press moves the ship this far, in points; a held key repeats. */
const SHIP_KEY_STEP = 22;
/** The ship flown by keys is let go this long after the last of them, as a lifted finger lets it go. */
const SHIP_KEY_LET_GO_MS = 700;
/** The ship goes round a globe whose radius on screen is over this (pixels): the same as the driver's `NAMED_FROM_PX`. */
const ORBIT_FROM_PX = 90;
/** The ship's size parked low in the sky, in points (the prototype's `hs = 32`). */
const PARKED_SIZE = 32;
/** The ship's size going round a globe, in points (the prototype's 26 for a planet in orbit). */
const ORBIT_SIZE = 26;
/** The ship's size standing on a region, in points. */
const REGION_SIZE = 30;
/** How far above a region's name point the ship stands, in points. */
const REGION_RISE = 22;
/** ... and under this: nearer than that the globe fills the view, and the ship parks instead. */
const ORBIT_TO_PX = 400;
/** The ship's orbit round a globe turns this fast, in radians per second (the prototype's `a = T * 0.5`). */
const ORBIT_RATE = 0.5;
/** The orbit's half width, as a share of the globe's radius (the prototype's `1.34`). */
const ORBIT_WIDTH = 1.34;
/** The orbit's half height, as a share of the globe's radius (the prototype's `0.34`). */
const ORBIT_HEIGHT = 0.34;
/** How far up the orbit's middle rides, as a share of the globe's radius (the prototype's `R * 0.1`). */
const ORBIT_RISE = 0.1;
/** A parked ship steps clear of a named place by at least this much, in points. */
const PARK_CLEARANCE = 24;
/** The view leans by at most this share of its short side (the prototype's `LM = min(W, H) * 0.3`). */
const LEAN_LIMIT = 0.3;
/** A parked ship hovers up and down by this much (points), at {@link BOB_RATE} (the prototype's `sin(1.3 T) * 2.5`). */
const BOB_HEIGHT = 2.5;
/** How fast a parked ship hovers (radians a second). */
const BOB_RATE = 1.3;

/**
 * At the outer stop the ship's lean moves the field this many times as far as it moves the universe's own view, so a
 * ship dragged across the sky carries a long way over the friends (eased in from 1, so entering never jumps).
 */
const OUTER_LEAN_GAIN = 3;
/** The gain eases in over about 0.3 s (a rate of 10 a second reaches 95 per cent then). */
const OUTER_GAIN_RATE = 10;
/** Leaving the outer stop, the field's lean fades into the ship's own at this rate a second, so the flight in never jumps. */
const OUTER_LEAN_FADE_RATE = 6;
/** A lean this near the ship's own, in points, has faded. */
const OUTER_LEAN_FADED = 0.5;
/** An arrow key turns the view, or at the outer stop moves the field, this far a press, in points. */
const KEY_PAN = 60;
/** The reported place of the universe is told on only when it moved this far (points) or its fade this much. */
const UNIVERSE_MOVED = 0.5;
const FADE_MOVED = 0.01;
const NO_PAN: Point = { x: 0, y: 0 };

/** The universe's reported place has changed enough to be worth drawing again. */
const moved = (told: UniverseOnScreen, next: UniverseOnScreen): boolean =>
  Math.hypot(next.x - told.x, next.y - told.y) >= UNIVERSE_MOVED ||
  Math.abs(next.radiusPx - told.radiusPx) >= UNIVERSE_MOVED ||
  Math.abs(next.fade - told.fade) >= FADE_MOVED ||
  (next.fade === 1) !== (told.fade === 1);
/** The ship is present enough to be named under (and so to be standing anywhere) above this share. */
const PRESENT_VIS = 0.9;
/** A pill that has moved less than this, in points, has not moved. */
const STANDS_STEP = 2;

/** A width and a height, in layout points. */
type Size = { readonly width: number; readonly height: number };

/** What the screen hands the controller on every render: where the person is, what they turned and what is drawn. */
export interface VoyageInputs {
  readonly session: UniverseMapSession;
  readonly view: UniverseView;
  readonly target: VoyageTarget;
  readonly size: Size;
  readonly turn: { readonly x: number; readonly y: number };
  readonly planet: VoyagePlanet | null;
  readonly siblings: readonly string[];
  readonly reducedMotion: boolean;
  /** The screen is on the product's desktop layout: the ship parks lower and may go nearer the edges. Default: a phone. */
  readonly desktop?: boolean;
  readonly universeFocus: Extract<RigFocus, { kind: 'universe' }>;
  readonly systemFocus: (systemId: string) => Extract<RigFocus, { kind: 'system' }> | undefined;
  /** Opens a room: what a tap on its station does, and what letting the ship go over it does. */
  readonly onStation?: (id: string) => void;
  /** Opens the map of the whole planet: what `M` does. Given only where a map can open (the ground of a planet with a formed region). */
  readonly onMap?: () => void;
  /** Told of each flight once it lands, when the frame-rate readout is on. */
  readonly onFlight?: (leg: FlightLeg) => void;
  /** Told when a flight starts and when it lands, so the screen can say where it is going. */
  readonly onFlying?: (flying: boolean) => void;
  /**
   * Told what the ship stands on whenever that changes, on the ground: the opened region under it, and where its pill
   * goes (`ground-home.ts`). Nothing at every other stop, and while the ship is held, flying or hidden.
   */
  readonly onStands?: (stands: Stands) => void;
  /**
   * Told what the fingers did, in one short line, whenever it changes ("pinch ×1.62 → in"), when the frame-rate readout
   * is on: one screenshot from a phone then shows which part of a gesture went wrong.
   */
  readonly onGesture?: (line: string) => void;
  /**
   * The outer stop of this screen (`outer/outer-stop.ts`), when it has one: at the universe stop a pinch out, a wheel
   * notch out or `-` goes past the rim instead of up, and at the outer stop the same three do nothing and a pinch in,
   * a wheel in, `+` or `=` come back. Absent (a friend's Universe, the trial off), every one is as it was.
   */
  readonly outer?: OuterStop | null;
  /**
   * Holds a pan of the friends' field (a screen offset, in points) where the screen still shows enough friends; the
   * identity when absent. Read each time the field is moved.
   */
  readonly clampOuterPan?: (pan: Point) => Point;
  /** A fall into the stop to make (a friend's Universe after the crossing film): each id falls once. */
  readonly fallIn?: FallIn | null;
}

/** The nearest visible anchor of one of `kinds` to a point on screen. */
function nearestAnchor(anchors: readonly SpaceAnchor[], kinds: readonly SpaceAnchor['kind'][], x: number, y: number) {
  let best: SpaceAnchor | undefined;
  let bestDistance = Infinity;
  for (const anchor of anchors) {
    if (!anchor.visible || !kinds.includes(anchor.kind)) continue;
    const distance = Math.hypot(anchor.x - x, anchor.y - y);
    if (distance < bestDistance) {
      best = anchor;
      bestDistance = distance;
    }
  }
  return best;
}

/** Where one stop down goes from `view`, toward a point: the system or planet nearest it, the ground, or nowhere. */
export function descentOf(
  view: UniverseView,
  anchors: readonly SpaceAnchor[],
  x: number,
  y: number,
): { readonly focus: string } | 'land' | null {
  if (view.kind === 'universe') {
    const system = nearestAnchor(anchors, ['system'], x, y);
    return system === undefined ? null : { focus: system.id };
  }
  if (view.kind === 'system') {
    const planet = nearestAnchor(anchors, ['planet'], x, y);
    return planet === undefined ? null : { focus: planet.id };
  }
  return view.landed ? null : 'land';
}

/** Goes one stop down as {@link descentOf} says. Returns whether it moved. */
function goDown(session: UniverseMapSession, descent: ReturnType<typeof descentOf>): boolean {
  if (descent === null) return false;
  return descent === 'land' ? session.land() : session.focus(descent.focus);
}

/** One stop down, toward what is under a point: a system, a planet of the star, the ground of the planet. Returns whether it moved. */
export function descend(
  session: UniverseMapSession,
  view: UniverseView,
  anchors: readonly SpaceAnchor[],
  x: number,
  y: number,
): boolean {
  return goDown(session, descentOf(view, anchors, x, y));
}

/**
 * Places the ship could be let go over: everything named on screen (a landmark's pennant is not a place), each pulling
 * as its kind and its size on screen say (`ship-gravity.ts`).
 */
const shipTargets = (anchors: readonly SpaceAnchor[]): ShipTarget[] =>
  anchors
    .filter((anchor) => anchor.visible && anchor.kind !== 'dust' && anchor.kind !== 'landmark')
    .map((anchor) => ({ id: anchor.id, x: anchor.x, y: anchor.y, pull: pullOf(anchor.kind, anchor.radiusPx) }));

/**
 * The region the ship stands on at the ground: the one chosen, else the first formed region, which the camera comes
 * down over (the prototype stands it on the region you landed on). Null above the ground.
 */
export function standsOn(inputs: Pick<VoyageInputs, 'target' | 'planet'>): string | null {
  if (inputs.target.stop !== 'ground') return null;
  return inputs.target.regionId ?? inputs.planet?.labels[0]?.objectId ?? null;
}

/** What a parked ship steps clear of: everything named on screen, with at least {@link PARK_CLEARANCE} round it. */
const avoidOf = (anchors: readonly SpaceAnchor[]) =>
  anchors
    .filter((anchor) => anchor.visible)
    .map((anchor) => ({ x: anchor.x, y: anchor.y, r: Math.max(PARK_CLEARANCE, anchor.radiusPx) }));

/**
 * Where the ship parks above the ground: standing on the region you landed on, round the globe, or low in the sky. (On
 * the ground it is always landed, and `groundHome` says where.)
 */
export function homeOf(
  frame: Pick<VoyageFrame, 'globe' | 'size'>,
  anchors: readonly SpaceAnchor[],
  regionId: string | null,
  seconds: number,
  reducedMotion = false,
  desktop = false,
  obstacles: readonly Disc[] = [],
): ShipHome {
  const { width, height } = frame.size;
  const globe = frame.globe;
  const region = anchors.find((anchor) => anchor.kind === 'region' && anchor.visible && anchor.id === regionId);
  if (region) return { x: region.x, y: region.y - REGION_RISE, size: REGION_SIZE, heading: 0 };
  if (globe !== null && globe.radiusPx > ORBIT_FROM_PX && globe.radiusPx < ORBIT_TO_PX) {
    const angle = seconds * ORBIT_RATE;
    return {
      x: globe.x + Math.cos(angle) * globe.radiusPx * ORBIT_WIDTH,
      y: globe.y + Math.sin(angle) * globe.radiusPx * ORBIT_HEIGHT - globe.radiusPx * ORBIT_RISE,
      size: ORBIT_SIZE,
      heading: Math.atan2(Math.cos(angle) * ORBIT_HEIGHT, -Math.sin(angle)) + Math.PI / 2,
    };
  }
  const avoid = avoidOf(anchors).concat(obstacles);
  // Low in the sky the ship hovers gently, as the prototype's does; with reduced motion it holds still.
  const bob = reducedMotion ? 0 : Math.sin(seconds * BOB_RATE) * BOB_HEIGHT;
  const spot = parkingSpot({ anchor: { x: width / 2, y: height * shipLayoutOf(desktop).parkAt }, avoid });
  return { ...spot, y: spot.y + bob, size: PARKED_SIZE, heading: 0 };
}

/** What the stage holds to run the trial look: its renderer, its gestures and what it is told. */
export interface VoyageController {
  /** The renderer, with the controller's camera driving it, for `SpaceView`'s `load`. */
  readonly load: typeof loadSpaceRenderer;
  readonly responder: PanResponderInstance;
  /** Takes what the screen shows now. Call it after every render. */
  sync(inputs: VoyageInputs): void;
  /** The named points the last frame put on screen. A property, so the stage can hand it on as it is. */
  readonly setAnchors: (anchors: readonly SpaceAnchor[]) => void;
  /** Where the stage is in the window, so a touch can be turned into a point of the stage. */
  setOrigin(x: number, y: number): void;
  /** The web's wheel: one notch is one stop. */
  wheel(deltaY: number): void;
  /** A key the focused map heard. Returns whether it acted on it. */
  key(name: string): boolean;
  /** Where the whole universe was last reported on screen, once the friends' field has any of it in (`fade` above 0); else null. */
  readonly universe: () => UniverseOnScreen | null;
  /** How far the friends' field has been moved (a screen offset, in points); 0, 0 anywhere but the outer stop. */
  readonly fieldPan: () => Point;
  /** Calls `listener` when {@link universe} changes by a visible amount, or the field is moved; returns the way to stop. */
  readonly subscribe: (listener: () => void) => () => void;
  /** The discs the friends' bubbles take on screen: the parked ship keeps off them. Pass `[]` once they are gone. */
  readonly setObstacles: (circles: readonly Disc[]) => void;
  /** Whether a finger took the ship, turned the land or pinched a moment ago: a press now is the end of that, not a tap on bare ground. */
  justGestured(): boolean;
  /**
   * A press on the planet's land that no name took, at the planet stop or on the ground (`bare-tap.ts`): the opened region
   * under it is focused, as its name does; else the globe lands, or bare ground opens the planet's map. The end of a gesture is no tap. A
   * property, so the stage can hand it on.
   */
  readonly tapBare: (event: GestureResponderEvent) => void;
  /** Ends the flight under way at once: the camera is where it was going. A property, so the stage can hand it on. */
  readonly skip: () => void;
  /** Stops what the controller started outside React (the wheel's rest timer). Call it when the stage goes. */
  dispose(): void;
}

/**
 * Everything the trial's stage changes from frame to frame and touch to touch, outside React: the driver's control, the
 * ship's motion, and the stage's own gestures (a finger on the ship flies it, one finger elsewhere turns what is in
 * front of you, two fingers pinch one stop in or out; a short press is left to the named buttons beneath).
 */
export function createVoyageController(first: VoyageInputs): VoyageController {
  let inputs = first;
  let anchors: readonly SpaceAnchor[] = [];
  let origin = { x: 0, y: 0 };
  let ship: ShipState = initialShip({
    x: first.size.width / 2,
    y: first.size.height * shipLayoutOf(first.desktop === true).parkAt,
    size: PARKED_SIZE,
    heading: 0,
  });
  let held: { x: number; y: number } | null = null;
  /** A body took the ship from the finger holding it: until that finger lifts, its moves neither take nor drop the ship. */
  let takenFromTouch = false;
  let seconds = 0;
  /** On the ground the ship has left its region and stands at its own spot on screen (`groundHome`). */
  let parked = false;
  /** What the ship was last told to stand on, so the screen hears only a change. */
  let stands: Stands = NOWHERE;
  const legs = createFlightLegs(first.target);
  /** The screen was last told a flight is under way ({@link VoyageInputs.onFlying}). */
  let flying = false;
  /** The friends' field: how far it has been moved (a screen offset, points), what the ship's lean multiplies by, what is in its way. */
  let fieldPan: Point = { x: 0, y: 0 };
  let leanGain = 1;
  let obstacles: readonly Disc[] = [];
  /** The view's lean at the outer stop, kept while it fades into the ship's own after leaving it; null at rest. */
  let carriedLean: Point | null = null;
  /** The universe's place as last told to {@link VoyageController.subscribe}, and who is listening. */
  let universeTold: UniverseOnScreen | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  const atOuterStop = () => inputs.view.kind === 'universe' && inputs.outer?.getState().on === true;
  const clampField = (pan: Point): Point => inputs.clampOuterPan?.(pan) ?? pan;
  /** The last frame was in a fall into the stop. */
  let fell = false;
  /** Which opened region's land is under a point of the screen, and where the globe is, as the last frame drew them. */
  let regionAtLast: VoyageFrame['regionAt'];
  let globeLast: VoyageFrame['globe'] = null;

  const control: VoyageControl = {
    target: first.target,
    turn: first.turn,
    planet: first.planet,
    siblings: first.siblings,
    reducedMotion: first.reducedMotion,
    universeFocus: first.universeFocus,
    systemFocus: first.systemFocus,
    lean: { x: 0, y: 0 },
    zoom: null,
    skips: 0,
    fallIn: first.fallIn ?? null,
    afterFrame: (frame): DrawnShip => {
      regionAtLast = frame.regionAt;
      globeLast = frame.globe;
      seconds += frame.dt;
      pinch.frame(frame.dt, frame.flying);
      const { width, height } = frame.size;
      const desktop = inputs.desktop === true;
      const layout = shipLayoutOf(desktop);
      const targets = shipTargets(anchors);
      const bounds = {
        left: layout.margins.side,
        right: width - layout.margins.side,
        top: Math.min(layout.margins.top, height * 0.25),
        bottom: height - Math.min(layout.margins.bottom, height * 0.3),
      };
      // A pinch moves the camera under the ship, so it goes, as it does for a flight (the prototype's `zoomBusy`).
      const away = frame.flying || pinch.pinching();
      // On the ground the ship is always landed: it stands over its region while that is on screen, else at its spot.
      const ground = inputs.target.stop === 'ground';
      let home: ShipHome;
      if (ground) {
        const placed = groundHome({
          anchors,
          regionId: standsOn(inputs),
          spot: { x: width / 2, y: height * layout.parkAt },
          avoid: avoidOf(anchors),
          bounds,
          parked,
        });
        home = placed.home;
        // While the view flies or is pinched the ship is hidden and the places move: it has parked nowhere, and when it is
        // back it stands on its region again.
        parked = !away && placed.parked;
      } else
        home = homeOf(
          frame,
          anchors,
          standsOn(inputs),
          seconds,
          inputs.reducedMotion,
          desktop,
          inputs.target.stop === 'outer' ? obstacles : undefined,
        );
      ship = stepShip(
        ship,
        {
          home,
          drag: held,
          targets,
          away,
          bounds,
          reducedMotion: inputs.reducedMotion,
          viewCentre: { x: width / 2, y: height * layout.leanCentre },
          leanLimit: Math.min(width, height) * LEAN_LIMIT,
          ground,
        },
        frame.dt,
      );
      tellStands(
        ground
          ? standsOf({
              busy: held !== null || ship.falling !== null || ship.lift > 0 || away || ship.vis <= PRESENT_VIS,
              free: ship.free,
              parked,
              regionId: standsOn(inputs),
              speed: Math.hypot(ship.vx, ship.vy),
              foot: footOf(ship),
              regionAt: frame.regionAt,
            })
          : NOWHERE,
      );
      const taken = takenFromFinger(ship, held !== null);
      if (taken !== null) {
        // A body took the ship from the hand: the hand lets go, and the rest of its touch neither moves nor drops it.
        if (keyHeld) stopKeys();
        else takenFromTouch = true;
        held = null;
        tell(`ship held → taken by ${nameOf(taken)}`);
        // Reduced motion has no fall to watch: it goes at once.
        if (inputs.reducedMotion) {
          ship = landShip(ship);
          go(taken, 'taken →');
        }
      }
      const reached = away ? null : arrival(ship, targets, bounds);
      if (reached !== null) {
        ship = landShip(ship);
        go(reached, 'drawn in →');
      }
      control.lean = leanOf(ship.lean, frame.dt);
      tellUniverse(frame.universe ?? null);
      // A fall into the stop (a friend's Universe after the crossing film) is timed as a flight of its own, and the
      // screen says nothing of it: the film has just said where you are going.
      const falling = frame.falling === true;
      if (falling && !fell) legs.asked(control.target, performance.now(), 'fall');
      fell = falling;
      const said = frame.flying && !falling;
      if (said !== flying) {
        flying = said;
        inputs.onFlying?.(flying);
      }
      const landed = legs.frame(frame.flying, frame.programs, performance.now());
      if (landed !== null) inputs.onFlight?.(landed);
      if (held !== null)
        tell(
          ship.candidate === null
            ? 'ship held · nothing near'
            : `ship held · pulled to ${nameOf(ship.candidate)} (${pullWord(ship.pullStrength)})`,
        );
      else if (pinch.pinching() && frame.flying) tell('pinch · hurrying the flight to its stop');
      const caught = ship.candidate === null ? undefined : targets.find((target) => target.id === ship.candidate);
      if (caught === undefined) return drawn(ship);
      // Lit in full where letting go now would go there (or the ship is already falling in), else as it pulls; held
      // inside a body's fall ring it fills toward full as the moment before the body takes it runs out.
      const goes =
        ship.falling !== null || Math.hypot(caught.x - ship.x, caught.y - ship.y) < (caught.pull ?? PLACE_PULL).capture;
      const lit = goes ? 1 : Math.max(ship.pullStrength, ship.dwell / HOLD_CAPTURE_SECONDS);
      return drawn(ship, { x: caught.x, y: caught.y }, lit);
    },
  };
  const pinch = createPinchGesture(control);
  const touches = createStageTouches();

  /** Tells the screen what the ship stands on, when that has changed. */
  const tellStands = (next: Stands) => {
    const same =
      next.id === stands.id &&
      (next.at === null || stands.at === null
        ? next.at === stands.at
        : Math.hypot(next.at.x - stands.at.x, next.at.y - stands.at.y) < STANDS_STEP);
    if (same) return;
    stands = next;
    inputs.onStands?.(next);
  };

  /** The line last told through `onGesture`. */
  let gestureLine = '';
  const tell = (line: string) => {
    if (line === gestureLine) return;
    gestureLine = line;
    inputs.onGesture?.(line);
  };
  const nameOf = (id: string | null): string =>
    (id === null ? undefined : anchors.find((anchor) => anchor.id === id)?.name) ?? 'nothing';
  const times = (ratio: number) => `×${ratio.toFixed(2)}`;
  /** How near the ship must be let go to a place for it to go there, drawn in or at once. */
  const letGoReach = (target: ShipTarget) => {
    const pull = target.pull ?? PLACE_PULL;
    return Math.max(pull.capture, pull.fall);
  };
  /** The pull in a word, so the readout's line changes only when the pull does, not on every frame. */
  const pullWord = (strength: number) => (strength > 0.66 ? 'strongly' : strength > 0.33 ? 'firmly' : 'gently');

  /** Flies to the place the ship was let go over or drawn into: a station opens its room, as a tap does. */
  const go = (id: string, how: string) => {
    if (anchors.some((anchor) => anchor.id === id && anchor.kind === 'station')) {
      tell(`ship ${how} opens ${nameOf(id)}`);
      inputs.onStation?.(id);
    } else {
      tell(`ship ${how} ${nameOf(id)}`);
      void inputs.session.focus(id);
    }
  };

  /**
   * The view's lean. At the outer stop the field is moved by moving the camera's aim, so the 3D universe and the layer
   * move together: the lean is the field's offset, taken the other way (a view that leans right shows everything
   * sliding left, `placeCamera`), less the ship's own lean times the gain, all held where the screen still shows
   * friends. Leaving, it fades into the ship's lean, so the flight in starts without a jump.
   */
  const leanOf = (shipLean: Point, dt: number): Point => {
    if (inputs.target.stop === 'outer') {
      const ease = inputs.reducedMotion ? 1 : 1 - Math.exp(-dt * OUTER_GAIN_RATE);
      leanGain += (OUTER_LEAN_GAIN - leanGain) * ease;
      carriedLean = outerLean(shipLean);
      return carriedLean;
    }
    leanGain = 1;
    if (carriedLean === null) return shipLean;
    const fade = inputs.reducedMotion ? 1 : 1 - Math.exp(-dt * OUTER_LEAN_FADE_RATE);
    const next = {
      x: carriedLean.x + (shipLean.x - carriedLean.x) * fade,
      y: carriedLean.y + (shipLean.y - carriedLean.y) * fade,
    };
    carriedLean = Math.hypot(next.x - shipLean.x, next.y - shipLean.y) < OUTER_LEAN_FADED ? null : next;
    return carriedLean ?? shipLean;
  };
  const outerLean = (shipLean: Point): Point => {
    const field = clampField({ x: fieldPan.x - shipLean.x * leanGain, y: fieldPan.y - shipLean.y * leanGain });
    return { x: -field.x, y: -field.y };
  };
  /** Moves the field to `pan` (held where the screen still shows friends), and tells whoever draws it, with no frame between. */
  const moveField = (pan: Point) => {
    fieldPan = clampField(pan);
    control.lean = outerLean(ship.lean);
    carriedLean = control.lean;
    notify();
  };
  /**
   * Says where the universe is on screen to the layer when it moved visibly, and never while the field is out of it (a
   * ship leaning at the universe stop would otherwise wake the layer every frame). It is told once at each end of the
   * fade, exactly, so the layer is neither left at a hair's opacity nor left mounted.
   */
  const tellUniverse = (next: UniverseOnScreen | null) => {
    const told = universeTold;
    const out = next === null || next.fade <= 0;
    if (out ? told === null || told.fade <= 0 : told !== null && told.fade > 0 && !moved(told, next)) return;
    universeTold = next;
    notify();
  };

  /** One stop out: past the rim at the whole universe when this screen has an outer stop, up the ladder anywhere else. Returns whether it moved. */
  const stepOut = (): boolean => {
    const outer = inputs.outer;
    if (!outer || inputs.view.kind !== 'universe') return climbOneStop(inputs.session, inputs.view);
    if (outer.getState().on) {
      tell('beyond your universe · nothing is farther out');
      return false;
    }
    fieldPan = NO_PAN;
    outer.enter();
    tell('out past your universe');
    return true;
  };
  /** One stop in: back from the outer stop, never to a star; anywhere else toward what is under a point. Returns whether it moved. */
  const stepIn = (towards: () => boolean): boolean => {
    if (!atOuterStop()) return towards();
    inputs.outer!.leave();
    tell('back to your universe');
    return true;
  };

  let startTurn = { x: 0, y: 0 };
  let startPan: Point = { x: 0, y: 0 };
  /**
   * Where a pinch in would go: what was under the fingers when they came down. It is chosen then, because the camera
   * zooms toward it as they spread and everything else moves on screen.
   */
  let pinchDescent: ReturnType<typeof descentOf> = null;
  const centre = () => ({ x: inputs.size.width / 2, y: inputs.size.height / 2 });
  const local = (event: GestureResponderEvent) => ({
    x: event.nativeEvent.pageX - origin.x,
    y: event.nativeEvent.pageY - origin.y,
  });
  const fingersOf = (event: GestureResponderEvent): Finger[] =>
    event.nativeEvent.touches.map((touch) => ({
      id: String(touch.identifier),
      x: touch.pageX - origin.x,
      y: touch.pageY - origin.y,
    }));

  /** Letting go of the held ship: a tap calls it home, a drop near a place goes there, anywhere else it stays. */
  const letGoOfShip = (moved: boolean) => {
    held = null;
    if (!moved) {
      parked = false;
      ship = recentreShip(ship);
      tell('ship tapped → home');
      return;
    }
    const candidate = ship.candidate;
    const targets = shipTargets(anchors);
    const reach = candidate === null ? undefined : targets.find((target) => target.id === candidate);
    const released = releaseShip(ship, targets, inputs.reducedMotion);
    ship = released.state;
    if (released.goTo !== null) go(released.goTo, 'let go →');
    else if (ship.falling !== null) tell(`ship let go → drawn into ${nameOf(ship.falling)}`);
    else if (reach)
      tell(
        `ship let go ${Math.round(Math.hypot(reach.x - ship.x, reach.y - ship.y))} pt from ${nameOf(reach.id)} (needs < ${Math.round(letGoReach(reach))}) → stays`,
      );
    else tell('ship let go in empty sky → stays');
  };

  let gesturedAt = Number.NEGATIVE_INFINITY;
  const justGestured = () => performance.now() - gesturedAt < AFTER_GESTURE_MS;
  const act = (gesture: StageGesture) => {
    gesturedAt = performance.now();
    switch (gesture.kind) {
      case 'ship-take':
        // A finger takes the ship from the keys: it is the finger's to let go now.
        stopKeys();
        takenFromTouch = false;
        held = gesture.at;
        tell('ship held');
        return;
      case 'ship-move':
        if (!takenFromTouch) held = gesture.at;
        return;
      case 'ship-let-go':
        // The finger that a body took the ship from lifts: the ship is already on its way, and stays so.
        if (takenFromTouch) takenFromTouch = false;
        else letGoOfShip(gesture.moved);
        return;
      case 'ship-home':
        // A second finger (or the system) took the touch: the ship is no longer held, and goes home.
        if (takenFromTouch) {
          takenFromTouch = false;
          return;
        }
        held = null;
        parked = false;
        ship = recentreShip(ship);
        tell('ship → home: a second finger came');
        return;
      case 'turn-begin':
        startTurn = { x: inputs.turn.x, y: inputs.turn.y };
        startPan = fieldPan;
        // Turning the view while the ship falls into a place is asking for something else: it stays where it is.
        if (ship.falling !== null) {
          ship = { ...ship, falling: null, candidate: null, pullStrength: 0 };
          tell('ship drawn in → stopped: the view was turned');
        }
        return;
      case 'turn':
        // Past the rim a drag moves the field with the finger, and nothing is stored.
        if (atOuterStop()) {
          moveField({ x: startPan.x + gesture.dx, y: startPan.y + gesture.dy });
          return;
        }
        inputs.session.camera({ x: startTurn.x - gesture.dx, y: startTurn.y - gesture.dy, scale: 1 });
        return;
      case 'pinch-begin':
        // Two fingers take the view from the keys: the ship they held goes home, with no drop.
        if (keyHeld) {
          stopKeys();
          held = null;
          parked = false;
          ship = recentreShip(ship);
        }
        // A pinch a finger landed again on carries on toward the place it was going to.
        if (!gesture.resumes) pinchDescent = descentOf(inputs.view, anchors, gesture.between.x, gesture.between.y);
        pinch.begin(gesture.spread, pinchDescent !== null && pinchDescent !== 'land' ? pinchDescent.focus : null);
        tell(`pinch ${times(pinch.ratio())}`);
        return;
      case 'pinch-move':
        // The camera follows the fingers (the prototype's `zoomTo`); with reduced motion it only moves on release.
        pinch.move(gesture.spread, !inputs.reducedMotion);
        tell(`pinch ${times(pinch.ratio())}`);
        return;
      case 'pinch-pause':
        tell(`pinch ${times(pinch.ratio())} · a finger lifted`);
        return;
      case 'pinch-end': {
        const ratio = pinch.ratio();
        const outcome = pinch.end((direction) =>
          direction === 'in' ? stepIn(() => goDown(inputs.session, pinchDescent)) : stepOut(),
        );
        tell(`pinch ${times(ratio)} → ${outcome} (a stop is ${times(PINCH_STEP)})`);
        return;
      }
      case 'pinch-cancel':
        pinch.cancel();
        tell('pinch taken away');
        return;
    }
  };
  const feed = (fingers: readonly Finger[]) => {
    for (const gesture of touches.update(fingers, (at) => pickShip(ship, at.x, at.y))) act(gesture);
  };

  // Every change of fingers goes to `touches`, which follows each finger by its id: a finger landing (grant, start),
  // moving, or lifting (end; release once the last one has).
  const responder = PanResponder.create({
    // A finger on the ship takes it at once, before a button under it can; so does a second finger, for a pinch.
    onStartShouldSetPanResponderCapture: (event) => {
      if (event.nativeEvent.touches.length >= 2) return true;
      const at = local(event);
      return pickShip(ship, at.x, at.y);
    },
    onMoveShouldSetPanResponderCapture: (event, gesture) =>
      event.nativeEvent.touches.length >= 2 || Math.abs(gesture.dx) + Math.abs(gesture.dy) > DRAG_START,
    onPanResponderGrant: (event) => feed(fingersOf(event)),
    onPanResponderStart: (event) => feed(fingersOf(event)),
    onPanResponderMove: (event) => feed(fingersOf(event)),
    onPanResponderEnd: (event) => feed(fingersOf(event)),
    onPanResponderRelease: () => feed([]),
    onPanResponderTerminate: () => {
      for (const gesture of touches.cancel()) act(gesture);
    },
    onPanResponderTerminationRequest: () => touches.mode() !== 'ship',
  });

  let wheelResting = false;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  /** The ship is held by the keys, not a finger, and the timer that lets it go. */
  let keyHeld = false;
  let keyTimer: ReturnType<typeof setTimeout> | undefined;
  const stopKeys = () => {
    clearTimeout(keyTimer);
    keyTimer = undefined;
    keyHeld = false;
  };
  /** Moves the ship one key step, taking it if it is free to take, and lets it go once the keys rest. */
  const flyShipBy = (dx: number, dy: number): boolean => {
    const at = drawn(ship);
    // Not while a pinch has the view or the ship is hidden (a flight), and not while a finger holds it.
    if (pinch.pinching() || !pickShip(ship, at.x, at.y)) return false;
    if (!keyHeld && held !== null) return false;
    const from = held ?? { x: ship.x, y: ship.y };
    const { width, height } = inputs.size;
    held = {
      x: Math.min(width, Math.max(0, from.x + dx * SHIP_KEY_STEP)),
      y: Math.min(height, Math.max(0, from.y + dy * SHIP_KEY_STEP)),
    };
    if (!keyHeld) tell('ship flown by keys');
    keyHeld = true;
    clearTimeout(keyTimer);
    keyTimer = setTimeout(() => {
      keyTimer = undefined;
      if (!keyHeld) return;
      keyHeld = false;
      letGoOfShip(true);
    }, SHIP_KEY_LET_GO_MS);
    return true;
  };
  return {
    load: loadVoyageRenderer(control),
    responder,
    sync(next) {
      if (targetKey(next.target) !== targetKey(inputs.target)) {
        // Going somewhere calls the ship home: it parks at the new stop. A pinch's zoom has done its work: the flight
        // leaves from where it left the camera. A ship the keys held is let go of with no drop: the keys' pause must
        // not send it anywhere from the new stop.
        if (keyHeld) {
          stopKeys();
          held = null;
        }
        parked = false;
        ship = recentreShip(ship);
        pinch.targetChanged();
        // The field starts from where it was drawn at rest each time the stop is entered.
        if (next.target.stop === 'outer') fieldPan = NO_PAN;
        legs.asked(next.target, performance.now());
      }
      inputs = next;
      control.target = next.target;
      control.turn = next.turn;
      control.planet = next.planet;
      control.siblings = next.siblings;
      control.reducedMotion = next.reducedMotion;
      control.universeFocus = next.universeFocus;
      control.systemFocus = next.systemFocus;
      control.fallIn = next.fallIn ?? null;
    },
    setAnchors(next) {
      anchors = next;
    },
    setOrigin(x, y) {
      origin = { x, y };
    },
    wheel(deltaY) {
      if (wheelResting) return;
      wheelResting = true;
      wheelTimer = setTimeout(() => (wheelResting = false), WHEEL_REST_MS);
      const at = centre();
      if (deltaY < 0) stepIn(() => descend(inputs.session, inputs.view, anchors, at.x, at.y));
      else stepOut();
    },
    key(name) {
      const { session, view } = inputs;
      const at = centre();
      // Built on the turn the last key asked for, not the last render's: a held arrow repeats faster than the screen
      // re-renders, and every press has to count.
      const turnBy = (dx: number, dy: number) => {
        control.turn = { x: control.turn.x + dx, y: control.turn.y + dy };
        session.camera({ ...control.turn, scale: 1 });
      };
      // Past the rim the arrows look round: ← slides the field right, as the drag that turns the view elsewhere does. They
      // move the field, not the stored camera.
      const lookBy = (dx: number, dy: number) =>
        atOuterStop() ? moveField({ x: fieldPan.x - dx, y: fieldPan.y - dy }) : turnBy(dx, dy);
      const down = () => stepIn(() => descend(session, view, anchors, at.x, at.y));
      const actions: Readonly<Record<string, () => void>> = {
        ArrowLeft: () => lookBy(-KEY_PAN, 0),
        ArrowRight: () => lookBy(KEY_PAN, 0),
        ArrowUp: () => lookBy(0, -KEY_PAN),
        ArrowDown: () => lookBy(0, KEY_PAN),
        '+': down,
        '=': down,
        '-': () => void stepOut(),
        Home: () => void session.focusLast(),
      };
      if (name.toLowerCase() === MAP_KEY && inputs.onMap !== undefined) {
        inputs.onMap();
        return true;
      }
      const shipKey = name.length === 1 ? SHIP_KEYS[name.toLowerCase()] : undefined;
      if (shipKey !== undefined) return flyShipBy(shipKey[0], shipKey[1]);
      const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
      action?.();
      return action !== undefined;
    },
    universe: () => (universeTold !== null && universeTold.fade > 0 ? universeTold : null),
    fieldPan: () => (inputs.target.stop === 'outer' ? fieldPan : NO_PAN),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setObstacles: (circles) => {
      obstacles = circles;
    },
    justGestured,
    tapBare: (event) => {
      if (justGestured()) return;
      // A press with no point (a keyboard's) is on no land: it is bare ground.
      const { pageX, pageY } = event.nativeEvent;
      const at = Number.isFinite(pageX) && Number.isFinite(pageY) ? local(event) : null;
      const regionId = at === null ? null : (regionAtLast?.(at.x, at.y) ?? null);
      const onGlobe =
        at !== null && globeLast !== null && Math.hypot(at.x - globeLast.x, at.y - globeLast.y) <= globeLast.radiusPx;
      const tap = bareTapOf(inputs.target.stop, regionId, { mapOpens: inputs.onMap !== undefined, onGlobe });
      if (tap.kind === 'region') void inputs.session.focus(tap.id);
      else if (tap.kind === 'land') void inputs.session.land();
      else if (tap.kind === 'map') inputs.onMap?.();
    },
    skip() {
      control.skips += 1;
    },
    dispose() {
      // A stage that has gone holds nothing: no body takes, and no key's rest drops, a ship it held.
      if (keyHeld) held = null;
      stopKeys();
      clearTimeout(wheelTimer);
      wheelTimer = undefined;
      wheelResting = false;
    },
  };
}
