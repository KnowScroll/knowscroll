/**
 * The camera of the Universe's trial look, after the design prototype (`Universe.dc.html`, Round 7.3): one camera that
 * moves along the ladder (ground, planet, star, the whole universe) and flies between stops, the planet you are at drawn
 * as one world, the person's ship drawn over it, and the names of the planet's regions as anchors. It drives the map's
 * existing scene (`SpaceCameraDriver`) and adds to it; it does not build a second one.
 *
 * It is made of parts, each in its own file: where places stand for the camera (`voyage-chains.ts`, pure), how a flight
 * moves between them (`flight.ts`, pure), which way the camera looks and where it stands (`voyage-view.ts`), the planet
 * drawn as one world (`planet-close-up.ts`) and the ship (`ship-layer.ts`). This file holds the flight under way and
 * puts the parts together each frame. It and its parts are the only files of the voyage that import `three`: they are
 * loaded on demand by `voyage-loader.ts`, so the screen and the controller never reach them at runtime.
 */
import * as THREE from 'three';
import type { Vec3 } from '../space/camera-rig';
import { smooth } from '../space/paint';
import type { BuiltSpace } from '../space/scene/build-scene';
import type { SpaceCameraDriver } from '../space/space-renderer';
import { flightAt, planFlight, type FlightPlan } from './flight';
import { targetKey, type VoyageTarget } from './ladder';
import { createPlanetCloseUp } from './planet-close-up';
import { createShipLayer } from './ship-layer';
import {
  chainOf,
  focalOf,
  peakOf,
  planetDistances,
  type ChainPlaces,
  type PlacedChain,
  type ViewSize,
} from './voyage-chains';
import type { VoyageControl, VoyagePlanet } from './voyage-control';
import { fieldOfView, heldOffset, placeCamera, vec, viewDirection } from './voyage-view';

/** How fast the camera eases back to its stop after a pinch lets go of it without moving a stop (per second). */
const ZOOM_RELAX_RATE = 6;
/** A pinch never takes the camera nearer a planet's centre than this many of its radii. */
const NEAREST_RADII = 1.15;
/** Pinched in to this share of its stop's distance, the camera aims wholly at the place under the fingers (1 / 1.4, the step). */
const AIMED_AT_ZOOM = 0.714;
/** An aim turned less than this toward a pinch's place is back on its stop. */
const AIM_FORGOTTEN = 1e-3;
/**
 * Two fingers that come down mid-flight make the rest of the flight this many times faster, so the camera reaches its
 * stop and the fingers take it from there. The prototype cancels the flight where it is (`zoomTo`); here a stop is the
 * only place the camera can rest, so it hurries to one instead of standing still between two.
 */
const PINCH_HURRY = 4;
/** How fast the hurry comes and goes, per second: a flight speeds up over a few frames, never in one. */
const HURRY_RATE = 8;
/**
 * How fast the camera goes to where the fingers have taken the zoom, per second, when a flight they hurried lands: they
 * may have spread or closed while it flew, and the camera must not jump there in one frame.
 */
const CATCH_UP_RATE = 10;
/** The camera has caught up with the fingers once its zoom is within this share of theirs. */
const CAUGHT_UP = 0.01;

/** A flight under way: its plan, how far through it is (seconds of flight, which a pinch can hurry) and the target it leaves. */
interface Flight {
  readonly plan: FlightPlan;
  /** Null until its first frame, which is its start. */
  elapsed: number | null;
  readonly from: VoyageTarget;
}

/**
 * The camera of the trial look (see the top of this file), made for one screen's {@link VoyageControl}. It is attached to
 * each scene the renderer builds, poses the camera every frame, draws the person's ship over the scene after it, and
 * gives the regions of the planet's globe back as anchors. `dispose` removes the globe and frees what it holds.
 */
export function createVoyageDriver(control: VoyageControl): SpaceCameraDriver {
  const closeUp = createPlanetCloseUp(control);
  const shipLayer = createShipLayer();
  /** The scene the driver was last attached to, and the one whose globe program has been compiled. */
  let attachedTo: BuiltSpace | null = null;
  let compiledFor: BuiltSpace | null = null;
  /** Scene time of the last frame, for its length. */
  let lastT: number | null = null;
  /** The length of the last frame, for the screen's ship. */
  let lastDt = 0;
  /** {@link targetKey} of the screen's target as last seen: a different one starts a flight. */
  let currentKey = '';
  /** Where the camera is: the places it is in, what it looks at and how far away, as of the last frame. */
  let station: { ids: readonly string[]; focus: Vec3; distance: number } | null = null;
  /** The target the camera was last sent to: what the next flight leaves. */
  let arrived: VoyageTarget | null = null;
  let flight: Flight | null = null;
  /** The pinch's zoom as drawn: the screen's while a pinch holds the camera, easing back to 1 when it lets go. */
  let zoom = 1;
  /** How far the camera's aim has turned toward the place a pinch in would go to (0 to 1), easing back with the zoom. */
  let aim = 0;
  /** Where the camera turns its aim while pinched in: the place's own point, as its stop would look at it. */
  let aimPoint: Vec3 | null = null;
  /**
   * A pinch held the camera in the last frame. The screen lets go of the pinch in the same moment it changes place,
   * so the flight that starts then is known to be a pinch's by this.
   */
  let pinchedLastFrame = false;
  /** {@link VoyageControl.skips} as last seen: a larger count ends the flight under way. */
  let skipsSeen = 0;
  /** How much faster than planned the flight under way runs: 1, or toward {@link PINCH_HURRY} while fingers pinch. */
  let hurry = 1;
  /** A flight landed under fingers that pinch: the zoom eases to theirs, at {@link CATCH_UP_RATE}, instead of jumping. */
  let catchingUp = false;
  /** The last planet the screen gave: kept while a flight leaves it, so its globe does not drop to the painted body. */
  let lastPlanet: VoyagePlanet | null = null;
  /** The planet drawn as a world now: the screen's, or the one a flight is still leaving. */
  const worldPlanet = (): VoyagePlanet | null => {
    if (control.planet !== null) lastPlanet = control.planet;
    else if (flight?.from.planetId !== lastPlanet?.planetId) lastPlanet = null;
    return control.planet ?? lastPlanet;
  };

  // Reused every frame: posing the camera makes no three.js vectors of its own.
  const direction = new THREE.Vector3();
  const cameraPosition = new THREE.Vector3();
  const planetPosition = new THREE.Vector3();
  const bodyAt = (space: BuiltSpace, planetId: string, into: THREE.Vector3) => {
    const body = space.script.planet(planetId);
    if (body === undefined) return undefined;
    return { id: planetId, position: body.object.getWorldPosition(into), radius: body.radius };
  };
  const chainPoint = new THREE.Vector3();
  const placesOf = (space: BuiltSpace): ChainPlaces => ({
    universeFocus: control.universeFocus,
    systemFocus: control.systemFocus,
    planetAt: (planetId) => {
      const body = bodyAt(space, planetId, chainPoint);
      return body && { position: vec(body.position), radius: body.radius };
    },
  });

  /** The point a pinch in turns the camera toward: a star's (from the whole universe) or a planet's (from its star). */
  const aimOf = (placeId: string | null, places: ChainPlaces, size: ViewSize): Vec3 | null => {
    if (placeId === null) return null;
    if (places.systemFocus(placeId) !== undefined)
      return chainOf({ stop: 'star', systemId: placeId, planetId: null, regionId: null }, places, size).chain[0]!.point;
    return places.planetAt(placeId)?.position ?? null;
  };

  /**
   * Starts a flight to a new target, or cuts to it on the first frame and under reduced motion. A flight a pinch asked
   * for is quicker: the fingers already moved the camera part of the way. Returns whether the target changed.
   */
  const retarget = (places: ChainPlaces, size: ViewSize, pinched: boolean): boolean => {
    const next = control.target;
    const key = targetKey(next);
    if (key === currentKey) return false;
    currentKey = key;
    const leaving = arrived;
    arrived = next;
    if (station === null || leaving === null || control.reducedMotion) {
      flight = null;
      return true;
    }
    const from = chainOf(leaving, places, size);
    const to = chainOf(next, places, size);
    flight = {
      plan: planFlight({
        fromDistance: station.distance,
        toDistance: to.stopDistance,
        peakDistance: peakOf(from, to),
        launchFocus: station.focus,
        fromChain: from.chain,
        toChain: to.chain,
        touchesGround: next.stop === 'ground' || leaving.stop === 'ground',
        fast: pinched,
      }),
      elapsed: null,
      from: leaving,
    };
    return true;
  };

  return {
    attach(space) {
      attachedTo = space;
      // The stage draws the rooms' stations itself, flat over the canvas (`station-layer.tsx`); the scene's own are not.
      space.showStations(false);
      closeUp.attach(space);
    },
    pose(t, space, size) {
      /** Since the last frame: a flight keeps to the clock, as it always has; easing steps at most 0.1 s. */
      const elapsed = lastT === null ? 0 : Math.max(0, t - lastT);
      const dt = Math.min(elapsed, 0.1);
      lastT = t;
      lastDt = dt;
      const places = placesOf(space);
      // A tap during a flight skips to its end (the prototype's `skip`): the camera is where it was going.
      if (control.skips !== skipsSeen) {
        skipsSeen = control.skips;
        flight = null;
      }
      // A new flight leaves from where the camera stands and looks, a pinch's zoom included, and carries it from there.
      if (retarget(places, size, pinchedLastFrame || control.zoom !== null)) zoom = 1;
      pinchedLastFrame = control.zoom !== null;
      const towardPoint = control.zoom === null ? null : aimOf(control.zoom.toward, places, size);
      if (flight !== null || control.reducedMotion) {
        zoom = 1;
        aim = 0;
        catchingUp = flight !== null && control.zoom !== null;
      } else if (control.zoom !== null && catchingUp) {
        zoom += (control.zoom.scale - zoom) * Math.min(1, dt * CATCH_UP_RATE);
        catchingUp = Math.abs(zoom / control.zoom.scale - 1) > CAUGHT_UP;
      } else if (control.zoom !== null) zoom = control.zoom.scale;
      else {
        catchingUp = false;
        zoom = 1 + (zoom - 1) * Math.exp(-dt * ZOOM_RELAX_RATE);
      }
      if (flight === null && !control.reducedMotion && towardPoint !== null) {
        aimPoint = towardPoint;
        aim = smooth(1, AIMED_AT_ZOOM, zoom);
      } else aim *= Math.exp(-dt * ZOOM_RELAX_RATE);
      // Once the aim is back on its stop, the point it turned toward is forgotten, so the next pinch starts afresh.
      if (aim < AIM_FORGOTTEN) {
        aim = 0;
        aimPoint = null;
      }
      const target = chainOf(control.target, places, size);
      let focus: Vec3;
      let distance: number;
      let q = 1;
      /** Where the flight under way left from, and that place's chain; both null at rest. */
      const leaving = flight?.from ?? null;
      let from: PlacedChain | null = null;
      if (flight !== null) {
        hurry += ((control.zoom === null ? 1 : PINCH_HURRY) - hurry) * Math.min(1, dt * HURRY_RATE);
        flight.elapsed = flight.elapsed === null ? 0 : flight.elapsed + elapsed * hurry;
        from = chainOf(flight.from, places, size);
        const frame = flightAt(flight.plan, flight.elapsed, from.chain, target.chain);
        focus = frame.focus;
        distance = frame.distance;
        q = frame.q;
        if (frame.done) flight = null;
      } else {
        hurry = 1;
        // At rest the camera looks at the place itself: on the ground too, the planet's centre, from nearer.
        distance = Math.max(target.stopDistance * zoom, (target.planetRadius ?? 0) * NEAREST_RADII);
        const here = target.chain[0]!.point;
        focus =
          aim > 0 && aimPoint !== null
            ? [
                here[0] + (aimPoint[0] - here[0]) * aim,
                here[1] + (aimPoint[1] - here[1]) * aim,
                here[2] + (aimPoint[2] - here[2]) * aim,
              ]
            : here;
      }
      station = { ids: target.ids, focus, distance };

      // The planet and star the camera is at, or the ones a flight still under way is leaving.
      const planetId = control.target.planetId ?? flight?.from.planetId ?? null;
      const planet = planetId === null ? undefined : bodyAt(space, planetId, planetPosition);
      const systemId = control.target.systemId ?? flight?.from.systemId ?? null;
      const sun = systemId === null ? undefined : space.script.sun(systemId);
      // The chain that holds the planet: the one flown to or, flying out of a planet, the one being left.
      const planetChain =
        target.planetRadius !== null ? target.chain : from !== null && from.planetRadius !== null ? from.chain : null;
      viewDirection(
        { stop: control.target.stop, turnX: control.turn.x, planet: planet?.position, sun, planetChain, distance },
        direction,
      );
      // Falling from a planet to its ground the lens lengthens, so the land is seen nearly from above.
      const groundDistance = planet === undefined ? null : planetDistances(planet.radius, size).ground;
      const fov = fieldOfView(planetChain, groundDistance, distance);
      const focal = focalOf(size, fov);
      const camera = placeCamera(
        {
          focus,
          direction,
          distance,
          lean: control.lean,
          held: heldOffset(leaving?.stop ?? null, control.target.stop, q, size.height),
          fov,
          focal,
        },
        cameraPosition,
      );

      // The globe: drawn over the painted planet once it is big enough to read, nearer the ground lit less and less.
      const world = planet === undefined ? null : worldPlanet();
      if (planet !== undefined && world?.planetId === planetId)
        closeUp.show(space, { t, dt, world, planet, sun, cameraPosition, focal, size });
      else closeUp.hide(space);
      // The person's own ship is drawn over the scene; the scene's parked rocket stays out of the way.
      space.script.shipScale(0);

      // A star or anything below it shows its own system alone once the camera has nearly arrived, and keeps it alone
      // for the first part of a flight away, so the other systems come in as the camera climbs and not at once. A
      // pinch out from a star keeps it alone too, as the prototype's does: the other stars come with the flight it asks
      // for. (They once came in at a fixed zoom, and a finger shaking about that zoom made the sky flicker.)
      const keptAlone = leaving !== null && leaving.stop !== 'universe' && q < 0.4 ? leaving.systemId : null;
      const alone = control.target.stop !== 'universe' && q > 0.6 ? control.target.systemId : keptAlone;
      space.showOnly(alone);
      return camera;
    },
    render(renderer, size) {
      if (attachedTo !== null && compiledFor !== attachedTo) {
        compiledFor = attachedTo;
        closeUp.compile(renderer, attachedTo);
      }
      const programs = renderer.info.programs?.length ?? 0;
      const space = attachedTo;
      const ship =
        control.afterFrame?.({
          dt: lastDt,
          flying: flight !== null,
          globe: closeUp.onScreen(),
          size,
          programs,
          ...(space === null ? {} : { regionAt: (x, y) => closeUp.regionAt(space, size, worldPlanet(), x, y) }),
        }) ?? null;
      // Too faint to see: the same threshold as `HIDDEN_ALPHA` in `ship-layer.ts`, which the layer also checks.
      if (ship === null || ship.alpha <= 0.02) return;
      // The ship sits over the scene in screen space, so it is drawn last on top of what is there.
      shipLayer.resize(size.width, size.height);
      shipLayer.draw(ship, lastT ?? 0);
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      try {
        renderer.clearDepth();
        renderer.render(shipLayer.scene, shipLayer.camera);
      } finally {
        renderer.autoClear = autoClear;
      }
    },
    anchors: (space, size) => closeUp.anchors(space, size, worldPlanet()),
    dispose() {
      closeUp.dispose();
      shipLayer.dispose();
    },
  };
}
