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
import { createFlightLegs } from './flight-legs';
import { createPinchGesture, PINCH_STEP } from './pinch-gesture';
import { climbOneStop, targetKey, type VoyageTarget } from './ladder';
import { PLACE_PULL, pullOf } from './ship-gravity';
import {
  arrival,
  drawn,
  initialShip,
  landShip,
  parkingSpot,
  pickShip,
  releaseShip,
  stepShip,
  type DrawnShip,
  type ShipHome,
  type ShipTarget,
  recentreShip,
  type ShipState,
} from './ship-motion';
import { createStageTouches, type Finger, type StageGesture } from './stage-touches';
import type { VoyageControl, VoyageFrame, VoyagePlanet } from './voyage-control';
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
   * Told what the fingers did, in one short line, whenever it changes ("pinch ×1.62 → in"), when the frame-rate readout
   * is on: one screenshot from a phone then shows which part of a gesture went wrong.
   */
  readonly onGesture?: (line: string) => void;
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

/** Where the ship parks at each stop: standing on the region you landed on, round the globe, or low in the sky. */
export function homeOf(
  frame: Pick<VoyageFrame, 'globe' | 'size'>,
  anchors: readonly SpaceAnchor[],
  regionId: string | null,
  seconds: number,
  reducedMotion = false,
  desktop = false,
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
  const avoid = anchors
    .filter((anchor) => anchor.visible)
    .map((anchor) => ({ x: anchor.x, y: anchor.y, r: Math.max(PARK_CLEARANCE, anchor.radiusPx) }));
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
  /** Whether a finger took the ship, turned the land or pinched a moment ago: a press now is the end of that, not a tap on bare ground. */
  justGestured(): boolean;
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
  let seconds = 0;
  const legs = createFlightLegs(first.target);
  /** A flight was under way in the last frame. */
  let flying = false;

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
    afterFrame: (frame): DrawnShip => {
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
      ship = stepShip(
        ship,
        {
          home: homeOf(frame, anchors, standsOn(inputs), seconds, inputs.reducedMotion, desktop),
          drag: held,
          targets,
          away,
          bounds,
          reducedMotion: inputs.reducedMotion,
          viewCentre: { x: width / 2, y: height * layout.leanCentre },
          leanLimit: Math.min(width, height) * LEAN_LIMIT,
        },
        frame.dt,
      );
      const reached = away ? null : arrival(ship, targets, bounds);
      if (reached !== null) {
        ship = landShip(ship);
        go(reached, 'drawn in →');
      }
      control.lean = ship.lean;
      if (frame.flying !== flying) {
        flying = frame.flying;
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
      // Lit in full where letting go now would go there (or the ship is already falling in), else as it pulls.
      const goes =
        ship.falling !== null || Math.hypot(caught.x - ship.x, caught.y - ship.y) < (caught.pull ?? PLACE_PULL).capture;
      return drawn(ship, { x: caught.x, y: caught.y }, goes ? 1 : ship.pullStrength);
    },
  };
  const pinch = createPinchGesture(control);
  const touches = createStageTouches();

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

  let startTurn = { x: 0, y: 0 };
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
  const act = (gesture: StageGesture) => {
    gesturedAt = performance.now();
    switch (gesture.kind) {
      case 'ship-take':
        // A finger takes the ship from the keys: it is the finger's to let go now.
        stopKeys();
        held = gesture.at;
        tell('ship held');
        return;
      case 'ship-move':
        held = gesture.at;
        return;
      case 'ship-let-go':
        letGoOfShip(gesture.moved);
        return;
      case 'ship-home':
        // A second finger (or the system) took the touch: the ship is no longer held, and goes home.
        held = null;
        ship = recentreShip(ship);
        tell('ship → home: a second finger came');
        return;
      case 'turn-begin':
        startTurn = { x: inputs.turn.x, y: inputs.turn.y };
        // Turning the view while the ship falls into a place is asking for something else: it stays where it is.
        if (ship.falling !== null) {
          ship = { ...ship, falling: null, candidate: null, pullStrength: 0 };
          tell('ship drawn in → stopped: the view was turned');
        }
        return;
      case 'turn':
        inputs.session.camera({ x: startTurn.x - gesture.dx, y: startTurn.y - gesture.dy, scale: 1 });
        return;
      case 'pinch-begin':
        // Two fingers take the view from the keys: the ship they held goes home, with no drop.
        if (keyHeld) {
          stopKeys();
          held = null;
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
          direction === 'in' ? goDown(inputs.session, pinchDescent) : climbOneStop(inputs.session, inputs.view),
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
        ship = recentreShip(ship);
        pinch.targetChanged();
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
      if (deltaY < 0) descend(inputs.session, inputs.view, anchors, at.x, at.y);
      else climbOneStop(inputs.session, inputs.view);
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
      const actions: Readonly<Record<string, () => void>> = {
        ArrowLeft: () => turnBy(-60, 0),
        ArrowRight: () => turnBy(60, 0),
        ArrowUp: () => turnBy(0, -60),
        ArrowDown: () => turnBy(0, 60),
        '+': () => descend(session, view, anchors, at.x, at.y),
        '=': () => descend(session, view, anchors, at.x, at.y),
        '-': () => climbOneStop(session, view),
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
    justGestured: () => performance.now() - gesturedAt < AFTER_GESTURE_MS,
    skip() {
      control.skips += 1;
    },
    dispose() {
      stopKeys();
      clearTimeout(wheelTimer);
      wheelTimer = undefined;
      wheelResting = false;
    },
  };
}
