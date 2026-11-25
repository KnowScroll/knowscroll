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
import { clamp } from '../space/paint';
import type { BuiltSpace } from '../space/scene/build-scene';
import type { SpaceCameraDriver } from '../space/space-renderer';
import { flightAt, planFlight, type Chain, type FlightPlan } from './flight';
import { targetKey, type VoyageTarget } from './ladder';
import { createPlanetCloseUp } from './planet-close-up';
import { createShipLayer } from './ship-layer';
import { chainOf, focalOf, peakOf, type ChainPlaces, type ViewSize } from './voyage-chains';
import type { VoyageControl, VoyagePlanet } from './voyage-control';
import { heldOffset, placeCamera, vec, viewDirection } from './voyage-view';

/** A flight under way: its plan, the time it started (set on its first frame) and the target it leaves. */
interface Flight {
  readonly plan: FlightPlan;
  startedAt: number | null;
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
  /** The last planet the screen gave: kept while a flight leaves it, so its globe does not drop to the painted body. */
  let lastPlanet: VoyagePlanet | null = null;
  /** The planet drawn as a world now: the screen's, or the one a flight is still leaving. */
  const worldPlanet = (): VoyagePlanet | null => {
    if (control.planet !== null) lastPlanet = control.planet;
    else if (flight?.from.planetId !== lastPlanet?.planetId) lastPlanet = null;
    return control.planet ?? lastPlanet;
  };

  // Reused every frame, so that posing the camera allocates nothing but the pose it returns.
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

  /** Starts a flight to a new target, or cuts to it on the first frame and under reduced motion. */
  const retarget = (places: ChainPlaces, size: ViewSize) => {
    const next = control.target;
    const key = targetKey(next);
    if (key === currentKey) return;
    currentKey = key;
    const leaving = arrived;
    arrived = next;
    if (station === null || leaving === null || control.reducedMotion) {
      flight = null;
      return;
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
      }),
      startedAt: null,
      from: leaving,
    };
  };

  return {
    attach(space) {
      attachedTo = space;
      closeUp.attach(space);
    },
    pose(t, space, size) {
      const dt = lastT === null ? 0 : clamp(t - lastT, 0, 0.1);
      lastT = t;
      lastDt = dt;
      const places = placesOf(space);
      retarget(places, size);
      const target = chainOf(control.target, places, size);
      let focus: Vec3;
      let distance: number;
      let q = 1;
      /** Where the flight under way left from, and that place's chain; both null at rest. */
      const leaving = flight?.from ?? null;
      let fromChain: Chain | null = null;
      if (flight !== null) {
        flight.startedAt ??= t;
        fromChain = chainOf(flight.from, places, size).chain;
        const frame = flightAt(flight.plan, t - flight.startedAt, fromChain, target.chain);
        focus = frame.focus;
        distance = frame.distance;
        q = frame.q;
        if (frame.done) flight = null;
      } else {
        // At rest the camera looks at the place itself: on the ground too, the planet's centre, from nearer.
        distance = target.stopDistance;
        focus = target.chain[0]!.point;
      }
      station = { ids: target.ids, focus, distance };

      // The planet and star the camera is at, or the ones a flight still under way is leaving.
      const planetId = control.target.planetId ?? flight?.from.planetId ?? null;
      const planet = planetId === null ? undefined : bodyAt(space, planetId, planetPosition);
      const systemId = control.target.systemId ?? flight?.from.systemId ?? null;
      const sun = systemId === null ? undefined : space.script.sun(systemId);
      // The chain that holds the planet: the one flown to or, flying out of a planet, the one being left.
      const planetChain = target.chain.length === 3 ? target.chain : fromChain?.length === 3 ? fromChain : null;
      viewDirection(
        { stop: control.target.stop, turnX: control.turn.x, planet: planet?.position, sun, planetChain, distance },
        direction,
      );
      const focal = focalOf(size);
      const camera = placeCamera(
        {
          focus,
          direction,
          distance,
          lean: control.lean,
          held: heldOffset(leaving?.stop ?? null, control.target.stop, q, size.height),
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
      // for the first part of a flight away, so the other systems come in as the camera climbs and not at once.
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
      const ship =
        control.afterFrame?.({ dt: lastDt, flying: flight !== null, globe: closeUp.onScreen(), size }) ?? null;
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
