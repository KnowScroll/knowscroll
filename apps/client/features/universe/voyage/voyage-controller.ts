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
import { createPinchGesture } from './pinch-gesture';
import { climbOneStop, targetKey, type VoyageTarget } from './ladder';
import {
  drawn,
  initialShip,
  parkingSpot,
  pickShip,
  releaseShip,
  stepShip,
  type DrawnShip,
  type ShipHome,
  recentreShip,
  type ShipState,
} from './ship-motion';
import type { VoyageControl, VoyageFrame, VoyagePlanet } from './voyage-control';
import { loadVoyageRenderer } from './voyage-loader';

/** A drag has to move this far before it turns the view; a shorter press is a tap on whatever is under it. */
const DRAG_START = 8;
/** Where the ship may go on a phone: clear of the header above and the chips below (the prototype's margins). */
const SHIP_MARGINS = { side: 26, top: 150, bottom: 204 } as const;
/** A wheel moves one stop, then waits this long before it moves another (the prototype's 260 ms `settle` timer). */
const WHEEL_REST_MS = 260;
/** Where the ship parks when none of its places is on screen: a share of the view's height down (the prototype's `H * 0.675`). */
const PARK_AT = 0.675;
/** The ship's size parked low in the sky, in points (the prototype's `hs = 32`). */
const PARKED_SIZE = 32;
/** The ship's size going round a globe, in points (the prototype's 26 for a planet in orbit). */
const ORBIT_SIZE = 26;
/** The ship's size standing on a region, in points. */
const REGION_SIZE = 30;
/** How far above a region's name point the ship stands, in points. */
const REGION_RISE = 22;
/** The ship goes round a globe whose radius on screen is over this (pixels): the same as the driver's `NAMED_FROM_PX`. */
const ORBIT_FROM_PX = 90;
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
/** The view leans from this far down, as a share of its height (the prototype's `ay = H * 0.56`). */
const LEAN_CENTRE = 0.56;
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
  readonly universeFocus: Extract<RigFocus, { kind: 'universe' }>;
  readonly systemFocus: (systemId: string) => Extract<RigFocus, { kind: 'system' }> | undefined;
  /** Opens a room: what a tap on its station does, and what letting the ship go over it does. */
  readonly onStation?: (id: string) => void;
  /** Told of each flight once it lands, when the frame-rate readout is on. */
  readonly onFlight?: (leg: FlightLeg) => void;
  /** Told when a flight starts and when it lands, so the screen can say where it is going. */
  readonly onFlying?: (flying: boolean) => void;
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

/** Places the ship could be let go over: everything named on screen. */
const shipTargets = (anchors: readonly SpaceAnchor[]) =>
  anchors
    .filter((anchor) => anchor.visible && anchor.kind !== 'dust')
    .map((anchor) => ({ id: anchor.id, x: anchor.x, y: anchor.y }));

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
  const spot = parkingSpot({ anchor: { x: width / 2, y: height * PARK_AT }, avoid });
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
    y: first.size.height * PARK_AT,
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
      pinch.frame(frame.dt);
      const { width, height } = frame.size;
      ship = stepShip(
        ship,
        {
          home: homeOf(frame, anchors, standsOn(inputs), seconds, inputs.reducedMotion),
          drag: held,
          targets: shipTargets(anchors),
          // A pinch moves the camera under the ship, so it goes, as it does for a flight (the prototype's `zoomBusy`).
          away: frame.flying || pinch.pinching(),
          bounds: {
            left: SHIP_MARGINS.side,
            right: width - SHIP_MARGINS.side,
            top: Math.min(SHIP_MARGINS.top, height * 0.25),
            bottom: height - Math.min(SHIP_MARGINS.bottom, height * 0.3),
          },
          reducedMotion: inputs.reducedMotion,
          viewCentre: { x: width / 2, y: height * LEAN_CENTRE },
          leanLimit: Math.min(width, height) * LEAN_LIMIT,
        },
        frame.dt,
      );
      control.lean = ship.lean;
      if (frame.flying !== flying) {
        flying = frame.flying;
        inputs.onFlying?.(flying);
      }
      const landed = legs.frame(frame.flying, frame.programs, performance.now());
      if (landed !== null) inputs.onFlight?.(landed);
      const caught = ship.candidate === null ? undefined : anchors.find((anchor) => anchor.id === ship.candidate);
      return drawn(ship, caught === undefined ? null : { x: caught.x, y: caught.y });
    },
  };
  const pinch = createPinchGesture(control);

  let mode: 'ship' | 'turn' | 'pinch' = 'turn';
  /** The held ship moved: letting go is a drop, not a tap. */
  let shipMoved = false;
  let startTurn = { x: 0, y: 0 };
  /**
   * Where a pinch in would go: what was under the fingers when they came down. It is chosen then, because the camera
   * zooms toward it as they spread and everything else moves on screen.
   */
  let pinchDescent: ReturnType<typeof descentOf> = null;
  const local = (event: GestureResponderEvent) => ({
    x: event.nativeEvent.pageX - origin.x,
    y: event.nativeEvent.pageY - origin.y,
  });
  const spread = (event: GestureResponderEvent) => {
    const [one, two] = event.nativeEvent.touches;
    return one && two ? Math.hypot(one.pageX - two.pageX, one.pageY - two.pageY) : 0;
  };
  const centre = () => ({ x: inputs.size.width / 2, y: inputs.size.height / 2 });
  const beginPinch = (event: GestureResponderEvent) => {
    const [one, two] = event.nativeEvent.touches;
    mode = 'pinch';
    const between =
      one && two
        ? { x: (one.pageX + two.pageX) / 2 - origin.x, y: (one.pageY + two.pageY) / 2 - origin.y }
        : local(event);
    pinchDescent = descentOf(inputs.view, anchors, between.x, between.y);
    pinch.begin(spread(event), pinchDescent !== null && pinchDescent !== 'land' ? pinchDescent.focus : null);
  };

  const responder = PanResponder.create({
    // A finger on the ship takes it at once, before a button under it can.
    onStartShouldSetPanResponderCapture: (event) => {
      const at = local(event);
      return pickShip(ship, at.x, at.y);
    },
    onMoveShouldSetPanResponderCapture: (event, gesture) =>
      spread(event) > 0 || Math.abs(gesture.dx) + Math.abs(gesture.dy) > DRAG_START,
    onPanResponderGrant: (event) => {
      const at = local(event);
      if (spread(event) > 0) beginPinch(event);
      else if (pickShip(ship, at.x, at.y)) {
        mode = 'ship';
        held = at;
        shipMoved = false;
      } else mode = 'turn';
      startTurn = { x: inputs.turn.x, y: inputs.turn.y };
    },
    onPanResponderMove: (event, gesture) => {
      const now = spread(event);
      if (now > 0) {
        if (mode !== 'pinch') beginPinch(event);
        // The camera follows the fingers (the prototype's `zoomTo`); with reduced motion it only moves on release.
        pinch.move(now, !inputs.reducedMotion);
        return;
      }
      if (mode === 'ship') {
        held = local(event);
        shipMoved = true;
      } else if (mode === 'turn')
        inputs.session.camera({ x: startTurn.x - gesture.dx, y: startTurn.y - gesture.dy, scale: 1 });
    },
    onPanResponderRelease: () => {
      if (mode === 'ship') {
        held = null;
        // A tap on the ship calls it home; a drop over a place goes there.
        const released = shipMoved
          ? releaseShip(ship, shipTargets(anchors))
          : { state: recentreShip(ship), goTo: null };
        ship = released.state;
        // A station is a room, not a place on the map: letting the ship go over it opens the room, as a tap does.
        const goTo = released.goTo;
        if (goTo !== null && anchors.some((anchor) => anchor.id === goTo && anchor.kind === 'station'))
          inputs.onStation?.(goTo);
        else if (goTo !== null) void inputs.session.focus(goTo);
      } else if (mode === 'pinch') {
        pinch.end((direction) =>
          direction === 'in' ? goDown(inputs.session, pinchDescent) : climbOneStop(inputs.session, inputs.view),
        );
      }
      mode = 'turn';
    },
    onPanResponderTerminate: () => {
      held = null;
      mode = 'turn';
      pinch.cancel();
    },
    onPanResponderTerminationRequest: () => mode !== 'ship',
  });

  let wheelResting = false;
  let wheelTimer: ReturnType<typeof setTimeout> | undefined;
  return {
    load: loadVoyageRenderer(control),
    responder,
    sync(next) {
      if (targetKey(next.target) !== targetKey(inputs.target)) {
        // Going somewhere calls the ship home: it parks at the new stop. A pinch's zoom has done its work: the flight
        // leaves from where it left the camera.
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
      const action = Object.hasOwn(actions, name) ? actions[name] : undefined;
      action?.();
      return action !== undefined;
    },
    skip() {
      control.skips += 1;
    },
    dispose() {
      clearTimeout(wheelTimer);
      wheelTimer = undefined;
      wheelResting = false;
    },
  };
}
