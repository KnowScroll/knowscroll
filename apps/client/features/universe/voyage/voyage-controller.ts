import { PanResponder, type GestureResponderEvent, type PanResponderInstance } from 'react-native';
import type { RigFocus } from '../space/camera-rig';
import type { loadSpaceRenderer } from '../space/load-space-renderer';
import type { SpaceAnchor } from '../space/space-surface';
import type { UniverseView } from '../universe-layout';
import type { UniverseMapSession } from '../universe-session';
import { climbOneStop } from './ladder';
import {
  drawn,
  initialShip,
  parkingSpot,
  pickShip,
  releaseShip,
  stepShip,
  type DrawnShip,
  type ShipHome,
  type ShipState,
} from './ship-motion';
import type { VoyageControl, VoyageFrame, VoyagePlanet, VoyageTarget } from './voyage-driver';
import { loadVoyageRenderer } from './voyage-loader';

/** A pinch has to open or close by this much to move a stop (the prototype's 1.4 and 1/1.4). */
const PINCH_STEP = 1.4;
/** A drag has to move this far before it turns the view; a shorter press is a tap on whatever is under it. */
const DRAG_START = 8;
/** Where the ship may go on a phone: clear of the header above and the chips below (the prototype's margins). */
const SHIP_MARGINS = { side: 26, top: 150, bottom: 204 } as const;
/** A wheel moves one stop, then waits this long before it moves another. */
const WHEEL_REST_MS = 260;

type Size = { readonly width: number; readonly height: number };

/** What the screen hands the controller on every render. */
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

/** One stop down, toward what is under a point: a system, a planet of the star, the ground of the planet. */
export function descend(
  session: UniverseMapSession,
  view: UniverseView,
  anchors: readonly SpaceAnchor[],
  x: number,
  y: number,
): void {
  if (view.kind === 'universe') {
    const system = nearestAnchor(anchors, ['system'], x, y);
    if (system) void session.focus(system.id);
  } else if (view.kind === 'system') {
    const planet = nearestAnchor(anchors, ['planet'], x, y);
    if (planet) void session.focus(planet.id);
  } else if (!view.landed) void session.land();
}

/** Places the ship could be let go over: everything named on screen. */
const shipTargets = (anchors: readonly SpaceAnchor[]) =>
  anchors
    .filter((anchor) => anchor.visible && anchor.kind !== 'dust')
    .map((anchor) => ({ id: anchor.id, x: anchor.x, y: anchor.y }));

/** Where the ship parks at each stop: standing on the region you landed on, round the globe, or low in the sky. */
export function homeOf(
  frame: Pick<VoyageFrame, 'globe' | 'size'>,
  anchors: readonly SpaceAnchor[],
  regionId: string | null,
  seconds: number,
): ShipHome {
  const { width, height } = frame.size;
  const globe = frame.globe;
  const region = anchors.find((anchor) => anchor.kind === 'region' && anchor.visible && anchor.id === regionId);
  if (region) return { x: region.x, y: region.y - 22, size: 30, heading: 0 };
  if (globe !== null && globe.radiusPx > 90 && globe.radiusPx < 400) {
    const angle = seconds * 0.5;
    return {
      x: globe.x + Math.cos(angle) * globe.radiusPx * 1.34,
      y: globe.y + Math.sin(angle) * globe.radiusPx * 0.34 - globe.radiusPx * 0.1,
      size: 26,
      heading: Math.atan2(Math.cos(angle) * 0.34, -Math.sin(angle)) + Math.PI / 2,
    };
  }
  const avoid = anchors
    .filter((anchor) => anchor.visible)
    .map((anchor) => ({ x: anchor.x, y: anchor.y, r: Math.max(24, anchor.radiusPx) }));
  return { ...parkingSpot({ anchor: { x: width / 2, y: height * 0.675 }, avoid }), size: 32, heading: 0 };
}

export interface VoyageController {
  /** The renderer, with the controller's camera driving it, for `SpaceView`'s `load`. */
  readonly load: typeof loadSpaceRenderer;
  readonly responder: PanResponderInstance;
  /** Takes what the screen shows now. Call it after every render. */
  sync(inputs: VoyageInputs): void;
  /** The named points the last frame put on screen. */
  setAnchors(anchors: readonly SpaceAnchor[]): void;
  /** Where the stage is in the window, so a touch can be turned into a point of the stage. */
  setOrigin(x: number, y: number): void;
  /** The web's wheel: one notch is one stop. */
  wheel(deltaY: number): void;
  /** A key the focused map heard. Returns whether it acted on it. */
  key(name: string): boolean;
}

/**
 * Everything the Round 7.3 stage changes from frame to frame and touch to touch, outside React: the driver's control,
 * the ship's motion, and the stage's own gestures (a finger on the ship flies it, one finger elsewhere turns what is in
 * front of you, two fingers pinch one stop in or out; a short press is left to the named buttons beneath).
 */
export function createVoyageController(first: VoyageInputs): VoyageController {
  let inputs = first;
  let anchors: readonly SpaceAnchor[] = [];
  let origin = { x: 0, y: 0 };
  let ship: ShipState = initialShip({ x: first.size.width / 2, y: first.size.height * 0.675, size: 32, heading: 0 });
  let held: { x: number; y: number } | null = null;
  let seconds = 0;

  const control: VoyageControl = {
    target: first.target,
    turn: first.turn,
    planet: first.planet,
    siblings: first.siblings,
    reducedMotion: first.reducedMotion,
    universeFocus: first.universeFocus,
    systemFocus: first.systemFocus,
    lean: { x: 0, y: 0 },
    afterFrame: (frame): DrawnShip => {
      seconds += frame.dt;
      const { width, height } = frame.size;
      ship = stepShip(
        ship,
        {
          home: homeOf(frame, anchors, inputs.target.regionId, seconds),
          drag: held,
          targets: shipTargets(anchors),
          away: frame.flying,
          bounds: {
            left: SHIP_MARGINS.side,
            right: width - SHIP_MARGINS.side,
            top: Math.min(SHIP_MARGINS.top, height * 0.25),
            bottom: height - Math.min(SHIP_MARGINS.bottom, height * 0.3),
          },
          reducedMotion: inputs.reducedMotion,
          viewCentre: { x: width / 2, y: height * 0.56 },
          leanLimit: Math.min(width, height) * 0.3,
        },
        frame.dt,
      );
      control.lean = ship.lean;
      return drawn(ship);
    },
  };

  let mode: 'ship' | 'turn' | 'pinch' = 'turn';
  let startTurn = { x: 0, y: 0 };
  let startSpread = 0;
  let lastSpread = 0;
  let pinchAt = { x: 0, y: 0 };
  const local = (event: GestureResponderEvent) => ({
    x: event.nativeEvent.pageX - origin.x,
    y: event.nativeEvent.pageY - origin.y,
  });
  const spread = (event: GestureResponderEvent) => {
    const [one, two] = event.nativeEvent.touches;
    return one && two ? Math.hypot(one.pageX - two.pageX, one.pageY - two.pageY) : 0;
  };
  const centre = () => ({ x: inputs.size.width / 2, y: inputs.size.height / 2 });

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
      startSpread = spread(event);
      lastSpread = startSpread;
      pinchAt = at;
      if (startSpread > 0) mode = 'pinch';
      else if (pickShip(ship, at.x, at.y)) {
        mode = 'ship';
        held = at;
      } else mode = 'turn';
      startTurn = { x: inputs.turn.x, y: inputs.turn.y };
    },
    onPanResponderMove: (event, gesture) => {
      const now = spread(event);
      if (now > 0) {
        if (mode !== 'pinch') {
          mode = 'pinch';
          startSpread = now;
        }
        lastSpread = now;
        return;
      }
      if (mode === 'ship') held = local(event);
      else if (mode === 'turn')
        inputs.session.camera({ x: startTurn.x - gesture.dx, y: startTurn.y - gesture.dy, scale: 1 });
    },
    onPanResponderRelease: () => {
      if (mode === 'ship') {
        held = null;
        const released = releaseShip(ship, shipTargets(anchors));
        ship = released.state;
        if (released.goTo !== null) void inputs.session.focus(released.goTo);
      } else if (mode === 'pinch' && startSpread > 0) {
        const ratio = lastSpread / startSpread;
        if (ratio > PINCH_STEP) descend(inputs.session, inputs.view, anchors, pinchAt.x, pinchAt.y);
        else if (ratio < 1 / PINCH_STEP) climbOneStop(inputs.session, inputs.view);
      }
      mode = 'turn';
    },
    onPanResponderTerminate: () => {
      held = null;
      mode = 'turn';
    },
    onPanResponderTerminationRequest: () => mode !== 'ship',
  });

  let wheelResting = false;
  return {
    load: loadVoyageRenderer(control),
    responder,
    sync(next) {
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
      setTimeout(() => (wheelResting = false), WHEEL_REST_MS);
      const at = centre();
      if (deltaY < 0) descend(inputs.session, inputs.view, anchors, at.x, at.y);
      else climbOneStop(inputs.session, inputs.view);
    },
    key(name) {
      const { session, view, turn } = inputs;
      const at = centre();
      const turnBy = (dx: number, dy: number) => session.camera({ x: turn.x + dx, y: turn.y + dy, scale: 1 });
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
  };
}
