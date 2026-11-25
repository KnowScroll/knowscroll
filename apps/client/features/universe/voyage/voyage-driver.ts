import * as THREE from 'three';
import type { Chart, GlobeWorld } from '@knowscroll/scene-core';
import type { PlanetPalette } from '../planet/planet-palette';
import { distanceOf, FIELD_OF_VIEW, rigPose, type CameraPose, type RigFocus, type Vec3 } from '../space/camera-rig';
import { clamp, smooth } from '../space/paint';
import type { BuiltSpace } from '../space/scene/build-scene';
import type { SpaceCameraDriver } from '../space/space-renderer';
import type { SpaceAnchor } from '../space/space-surface';
import { flightAt, planFlight, type Chain, type FlightPlan } from './flight';
import { createGlobe, localPointOf } from './globe';
import { createShipLayer } from './ship-layer';
import type { DrawnShip } from './ship-motion';
import type { Stop } from './ladder';
import { createWorldPainter, type LabelPoint, type WorldPainter } from './world-texture';

/** Where the person is going: a stop of the ladder and the places that make it. */
export interface VoyageTarget {
  readonly stop: Stop;
  readonly systemId: string | null;
  readonly planetId: string | null;
  /** A chosen region on the ground: the camera comes down over it. */
  readonly regionId: string | null;
}

/** The planet the camera is at or going to, ready to be drawn as one world. */
export interface VoyagePlanet {
  /** Changes when the world or what is charted on it changes: the texture is painted again. */
  readonly key: string;
  readonly planetId: string;
  readonly world: GlobeWorld;
  readonly chart: Chart;
  readonly palette: PlanetPalette;
  /** Each formed region's name point, and its name. */
  readonly labels: readonly LabelPoint[];
  readonly names: ReadonlyMap<string, string>;
}

/**
 * What the screen tells the driver, by reference: it is read on every frame, so the screen changes it without
 * rebuilding the renderer.
 */
export interface VoyageControl {
  target: VoyageTarget;
  /** How far the person has dragged what is in front of them, in layout points. */
  turn: { readonly x: number; readonly y: number };
  planet: VoyagePlanet | null;
  /** The planets of the star the camera is at: near a planet, the others step aside so its world fills the view. */
  siblings: readonly string[];
  reducedMotion: boolean;
  universeFocus: Extract<RigFocus, { kind: 'universe' }>;
  systemFocus: (systemId: string) => Extract<RigFocus, { kind: 'system' }> | undefined;
  /** How far the view leans with the ship, in layout points (0, 0 when it does not). */
  lean: { readonly x: number; readonly y: number };
  /** Called after each frame drawn: the screen moves the ship with the frame and says where to draw it, if anywhere. */
  afterFrame?: (frame: VoyageFrame) => DrawnShip | null;
}

/** What the screen learns after each frame. */
export interface VoyageFrame {
  readonly dt: number;
  /** A flight is under way: the ship is not drawn. */
  readonly flying: boolean;
  /** Where the planet's globe is on screen, when it is drawn. */
  readonly globe: { readonly x: number; readonly y: number; readonly radiusPx: number } | null;
  readonly size: { readonly width: number; readonly height: number };
}

/**
 * The textures of a planet's world, painted a few milliseconds per frame: a quick one so the globe has its continents
 * within a second or so, then a sharper one for the ground, swapped in when it is done. On the ground the sphere is
 * about 4,700 device pixels round, so even the second is soft there.
 */
const TEXTURES = [
  { width: 1024, height: 512 },
  { width: 2048, height: 1024 },
] as const;
const PAINT_BUDGET_MS = 4;
/** One turn of the globe in 70 s when nothing else turns it (the prototype's idle spin). */
const SPIN_PER_SECOND = (2 * Math.PI) / 70;
/** How the turn a finger gives (points) becomes an angle round a star or the whole universe. */
const TURN_RADIANS_PER_POINT = 0.004;
const VIEW_ELEVATION = (30 * Math.PI) / 180;
/**
 * A star is seen from farther than the map's System view framed it: in the prototype its sun is a small bright ball
 * with its planets round it, not a disc filling a third of the screen.
 */
const STAR_DISTANCE_SCALE = 1.6;
/** Where each stop holds what it looks at, as a share of the view's height from the top (the prototype's `anchorY`). */
const HELD_AT: Readonly<Record<Stop, number>> = { universe: 0.455, star: 0.5, planet: 0.415, ground: 0.45 };

const TAN_HALF_FOV = Math.tan(((FIELD_OF_VIEW / 2) * Math.PI) / 180);

/** Pixels on screen for one scene unit at one unit of distance: the camera's focal length in layout points. */
const focalOf = (size: { readonly height: number }): number => size.height / 2 / TAN_HALF_FOV;

/**
 * The camera distances of a planet and of the ground for a planet of `radius`, after the prototype: from orbit the
 * globe is 0.36 of the short side across in radius; on the ground it is larger than the screen.
 */
function planetDistances(radius: number, size: { readonly width: number; readonly height: number }) {
  const focal = focalOf(size);
  const short = Math.min(size.width, 0.62 * size.height);
  const ground = Math.max(1.25 * short, 0.54 * Math.hypot(size.width, size.height));
  return { planet: (focal * radius) / (0.36 * short), ground: (focal * radius) / ground };
}

const vec = (point: THREE.Vector3): Vec3 => [point.x, point.y, point.z];

/** A link per place the chain passes through, with ids so two chains can be compared. */
interface PlacedChain {
  readonly ids: readonly string[];
  readonly chain: Chain;
  readonly stopDistance: number;
  readonly planetRadius: number | null;
}

const UNIVERSE_ID = 'universe';

/** Makes every link farther than the one before, so the focus never has to move along a link of no length. */
function increasing(chain: Chain): Chain {
  const result: { distance: number; point: Vec3 }[] = [];
  for (const link of chain) {
    const floor = result.length === 0 ? 0 : result[result.length - 1]!.distance * 1.25;
    result.push({ distance: Math.max(link.distance, floor), point: link.point });
  }
  return result;
}

/** Turns the drag into a direction round a star or the whole universe: the camera looks down at 30 degrees. */
function orbitDirection(turnX: number): THREE.Vector3 {
  const azimuth = turnX * TURN_RADIANS_PER_POINT;
  return new THREE.Vector3(
    Math.sin(azimuth) * Math.cos(VIEW_ELEVATION),
    Math.sin(VIEW_ELEVATION),
    Math.cos(azimuth) * Math.cos(VIEW_ELEVATION),
  );
}

/** From a planet, the camera stands a little round from its sun, so its day side and its terminator both show. */
function planetDirection(planet: THREE.Vector3, sun: THREE.Vector3): THREE.Vector3 {
  const away = new THREE.Vector3(sun.x - planet.x, 0, sun.z - planet.z);
  if (away.lengthSq() < 1e-9) away.set(0, 0, 1);
  away.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), 0.6);
  return away
    .multiplyScalar(Math.cos(0.32))
    .add(new THREE.Vector3(0, Math.sin(0.32), 0))
    .normalize();
}

const wrapAngle = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));

/**
 * The camera of the Universe's Round 7.3 look on trial: one camera that moves along the ladder (ground, planet, star,
 * the whole universe) and flies between stops, the planet you are at drawn as one world, and the names of its regions.
 * It drives the existing scene and adds to it; it does not build a second one.
 */
export function createVoyageDriver(control: VoyageControl): SpaceCameraDriver {
  const globe = createGlobe();
  const shipLayer = createShipLayer();
  let attachedTo: BuiltSpace | null = null;
  let lastT: number | null = null;
  let targetKey = '';
  let station: { ids: readonly string[]; focus: Vec3; distance: number } | null = null;
  /** The target the camera was at or heading to, before the current one. */
  let arrived: VoyageTarget | null = null;
  let flight: { plan: FlightPlan; startedAt: number | null; from: VoyageTarget } | null = null;
  let lastDt = 0;
  let painting: { key: string; size: number; painter: WorldPainter } | null = null;
  /** The planet whose texture is on the globe, and which of {@link TEXTURES} it is. */
  let painted: { key: string; size: number } | null = null;
  const orientation = { lon: 0, lat: 0 };
  let globeScreen: VoyageFrame['globe'] = null;
  /** The planet whose painted body, glow and neighbours the globe has set aside, to give them back when it goes. */
  let closeUpOf: { id: string; siblings: readonly string[] } | null = null;
  const giveBack = (space: BuiltSpace) => {
    if (closeUpOf === null) return;
    space.script.closeUp(closeUpOf.id, undefined);
    for (const id of [closeUpOf.id, ...closeUpOf.siblings]) {
      const body = space.script.planet(id);
      if (body) body.object.visible = true;
    }
    closeUpOf = null;
  };
  /**
   * Near a planet its globe takes over: the painted body under it and its haze of air fade, the sun's glow dims, and
   * the other planets of the star step aside, as the prototype's planet stop shows one world alone.
   */
  const setAside = (space: BuiltSpace, planetId: string, opacity: number) => {
    if (closeUpOf !== null && closeUpOf.id !== planetId) giveBack(space);
    closeUpOf = { id: planetId, siblings: control.siblings.filter((id) => id !== planetId) };
    space.script.closeUp(planetId, {
      atmosphere: 1.15 * (1 - opacity),
      sunBloom: 1 - 0.85 * opacity,
      sunGlow: 1 - 0.85 * opacity,
    });
    const body = space.script.planet(planetId);
    if (body) body.object.visible = opacity < 0.98;
    for (const id of closeUpOf.siblings) {
      const sibling = space.script.planet(id);
      if (sibling) sibling.object.visible = opacity < 0.5;
    }
  };
  let lastPose: CameraPose | null = null;
  /** The last planet the screen gave: kept while a flight leaves it, so its globe does not drop to the painted body. */
  let lastPlanet: VoyagePlanet | null = null;
  /** The planet drawn as a world now: the screen's, or the one a flight is still leaving. */
  const worldPlanet = (): VoyagePlanet | null => {
    if (control.planet !== null) lastPlanet = control.planet;
    else if (flight?.from.planetId !== lastPlanet?.planetId) lastPlanet = null;
    return control.planet ?? lastPlanet;
  };

  const scratch = new THREE.Vector3();
  const planetAt = (space: BuiltSpace, planetId: string) => {
    const body = space.script.planet(planetId);
    if (body === undefined) return undefined;
    return { id: planetId, position: body.object.getWorldPosition(new THREE.Vector3()), radius: body.radius };
  };

  const chainOf = (space: BuiltSpace, target: VoyageTarget, size: { width: number; height: number }): PlacedChain => {
    const universe = rigPose({ focus: control.universeFocus, frame: { x: 0, y: 0, scale: 1 }, ...size });
    const universeLink = { distance: distanceOf(universe), point: universe.target };
    const systemFocus = target.systemId === null ? undefined : control.systemFocus(target.systemId);
    if (target.stop === 'universe' || systemFocus === undefined || target.systemId === null)
      return { ids: [UNIVERSE_ID], chain: [universeLink], stopDistance: universeLink.distance, planetRadius: null };
    const system = rigPose({ focus: systemFocus, frame: { x: 0, y: 0, scale: 1 }, ...size });
    const systemLink = { distance: distanceOf(system) * STAR_DISTANCE_SCALE, point: system.target };
    const planet = target.planetId === null ? undefined : planetAt(space, target.planetId);
    if (target.stop === 'star' || planet === undefined || target.planetId === null)
      return {
        ids: [target.systemId, UNIVERSE_ID],
        chain: increasing([systemLink, universeLink]),
        stopDistance: systemLink.distance,
        planetRadius: null,
      };
    const distances = planetDistances(planet.radius, size);
    const chain = increasing([{ distance: distances.planet, point: vec(planet.position) }, systemLink, universeLink]);
    return {
      ids: [target.planetId, target.systemId, UNIVERSE_ID],
      chain,
      stopDistance: target.stop === 'ground' ? distances.ground : chain[0]!.distance,
      planetRadius: planet.radius,
    };
  };

  /** The distance of the first place both chains hold, when neither end holds the other. */
  const peakOf = (from: PlacedChain, to: PlacedChain): number | null => {
    if (to.ids.includes(from.ids[0]!) || from.ids.includes(to.ids[0]!)) return null;
    const shared = to.ids.findIndex((id) => from.ids.includes(id));
    return shared < 0 ? null : to.chain[shared]!.distance;
  };

  const keyOf = (target: VoyageTarget) =>
    `${target.stop}|${target.systemId ?? ''}|${target.planetId ?? ''}|${target.regionId ?? ''}`;

  /** Starts a flight to a new target, or cuts to it on the first frame and under reduced motion. */
  const retarget = (space: BuiltSpace, size: { width: number; height: number }) => {
    const next = control.target;
    const key = keyOf(next);
    if (key === targetKey) return;
    targetKey = key;
    const leaving = arrived;
    arrived = next;
    if (station === null || leaving === null || control.reducedMotion) {
      flight = null;
      return;
    }
    const from = chainOf(space, leaving, size);
    const to = chainOf(space, next, size);
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

  const paintStep = () => {
    const planet = worldPlanet();
    if (planet === null) return;
    if (painting !== null && painting.key !== planet.key) painting = null;
    if (painted?.key !== planet.key && painting === null) {
      painting = { key: planet.key, size: 0, painter: createWorldPainter({ ...planet, ...TEXTURES[0] }) };
      painted = null;
      globe.setTexture(null);
      globe.setColours({ sea: planet.palette.sea[0], cap: planet.palette.cloud[0], air: planet.palette.atmosphere });
    } else if (painting === null && painted !== null && painted.size + 1 < TEXTURES.length) {
      const size = painted.size + 1;
      painting = { key: planet.key, size, painter: createWorldPainter({ ...planet, ...TEXTURES[size]! }) };
    }
    if (painting !== null && painting.painter.step(control.reducedMotion ? Infinity : PAINT_BUDGET_MS)) {
      globe.setTexture(painting.painter.result());
      painted = { key: painting.key, size: painting.size };
      painting = null;
    }
  };

  /** Turns the globe so the point (`lon`, `lat`) faces the camera, north up. */
  const orient = (direction: THREE.Vector3) => {
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(direction, -direction.y).normalize();
    const right = new THREE.Vector3().crossVectors(up, direction).normalize();
    const facing = new THREE.Matrix4().makeBasis(right, up, direction);
    const turn = new THREE.Matrix4()
      .makeRotationX(orientation.lat)
      .multiply(new THREE.Matrix4().makeRotationY(-orientation.lon));
    globe.mesh.quaternion.setFromRotationMatrix(facing.multiply(turn));
  };

  /** Where the globe should face: on the ground the chosen region (or the first); from orbit a slow spin from the first. */
  const wantedOrientation = (t: number, radiusPx: number) => {
    const planet = worldPlanet();
    const turnLon = control.turn.x / Math.max(radiusPx, 1);
    const turnLat = control.turn.y / Math.max(radiusPx, 1);
    if (control.target.stop === 'ground' && planet !== null) {
      const region =
        planet.labels.find((label) => label.objectId === control.target.regionId) ?? planet.labels[0] ?? null;
      const lon = region === null ? 0 : (region.x / 480) * 2 * Math.PI - Math.PI;
      return { lon: lon + turnLon, lat: clamp((region?.lat ?? 0) - turnLat, -1.2, 1.2) };
    }
    // From orbit the globe turns slowly, starting with the first formed region facing you.
    const first = planet?.labels[0];
    const facing = first === undefined ? 0 : (first.x / 480) * 2 * Math.PI - Math.PI;
    const spin = control.reducedMotion ? 0 : t * SPIN_PER_SECOND;
    return { lon: facing + spin + turnLon, lat: clamp((first?.lat ?? 0) * 0.5 - turnLat, -0.95, 0.95) };
  };

  return {
    attach(space) {
      attachedTo = space;
      closeUpOf = null;
      space.scene.add(globe.mesh);
    },
    pose(t, space, size) {
      const dt = lastT === null ? 0 : clamp(t - lastT, 0, 0.1);
      lastT = t;
      lastDt = dt;
      if (attachedTo !== space) this.attach(space);
      retarget(space, size);
      const target = chainOf(space, control.target, size);
      let focus: Vec3;
      let distance: number;
      let q = 1;
      /** Where the flight under way left from, and that place's chain; both null at rest. */
      const leaving = flight?.from ?? null;
      let fromChain: Chain | null = null;
      if (flight !== null) {
        flight.startedAt ??= t;
        fromChain = chainOf(space, flight.from, size).chain;
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

      // The camera turns from looking down at a star toward the day side of the planet as it comes in.
      const planetId = control.target.planetId ?? flight?.from.planetId ?? null;
      const planet = planetId === null ? undefined : planetAt(space, planetId);
      const systemId = control.target.systemId ?? flight?.from.systemId ?? null;
      const sun = systemId === null ? undefined : space.script.sun(systemId);
      let direction = orbitDirection(
        control.target.stop === 'star' || control.target.stop === 'universe' ? control.turn.x : 0,
      );
      // The chain that holds the planet: the one flown to or, flying out of a planet, the one being left. Turning
      // by the distance along it eases the bearing both ways; without the second case the camera would snap from
      // the day side to the star's orbit view on the first frame of a flight out.
      const planetChain = target.chain.length === 3 ? target.chain : fromChain?.length === 3 ? fromChain : null;
      if (planet !== undefined && sun !== undefined && planetChain !== null) {
        const towardPlanet = smooth(
          0,
          1,
          (Math.log(planetChain[1]!.distance) - Math.log(distance)) /
            (Math.log(planetChain[1]!.distance) - Math.log(planetChain[0]!.distance)),
        );
        direction = direction.lerp(planetDirection(planet.position, sun), towardPlanet).normalize();
      }

      // The view leans with the ship: it moves sideways in its own plane, so near things slide past faster.
      const focal = focalOf(size);
      const up = new THREE.Vector3(0, 1, 0).addScaledVector(direction, -direction.y).normalize();
      const right = new THREE.Vector3().crossVectors(up, direction).normalize();
      const leanUnits = distance / focal;
      // Holding the subject above the middle means looking a little below it. In flight the height moves from the
      // stop left to the stop ahead with the flight, so the view never jumps when a flight starts.
      const heldAt =
        leaving === null
          ? HELD_AT[control.target.stop]
          : THREE.MathUtils.lerp(HELD_AT[leaving.stop], HELD_AT[control.target.stop], smooth(0, 1, q));
      const held = (0.5 - heldAt) * size.height;
      const leaned = new THREE.Vector3(...focus)
        .addScaledVector(right, control.lean.x * leanUnits)
        .addScaledVector(up, -(control.lean.y + held) * leanUnits);
      const position = leaned.clone().addScaledVector(direction, distance);
      lastPose = { position: vec(position), target: vec(leaned), fov: FIELD_OF_VIEW };

      // The globe: drawn over the painted planet once it is big enough to read, nearer the ground lit less and less.
      globeScreen = null;
      if (planet !== undefined && worldPlanet()?.planetId === planetId) {
        paintStep();
        const radiusPx = (focal * planet.radius) / Math.max(planet.position.distanceTo(position), 1e-6);
        const opacity = smooth(20, 60, radiusPx);
        globe.mesh.visible = opacity > 0.01;
        if (globe.mesh.visible) setAside(space, planet.id, opacity);
        else giveBack(space);
        globe.mesh.position.copy(planet.position);
        globe.mesh.scale.setScalar(planet.radius * 1.004);
        const wanted = wantedOrientation(t, radiusPx);
        const follow = control.reducedMotion ? 1 : 1 - Math.exp(-dt * 3.2);
        orientation.lon += wrapAngle(wanted.lon - orientation.lon) * follow;
        orientation.lat += (wanted.lat - orientation.lat) * follow;
        orient(position.clone().sub(planet.position).normalize());
        globe.setLight(
          sun === undefined ? new THREE.Vector3(-0.45, 0.55, 0.7) : sun.clone().sub(planet.position),
          smooth(200, 430, radiusPx),
          opacity,
        );
        const centre = planet.position.clone().project(space.camera);
        globeScreen = {
          x: (centre.x * 0.5 + 0.5) * size.width,
          y: (-centre.y * 0.5 + 0.5) * size.height,
          radiusPx,
        };
      } else {
        globe.mesh.visible = false;
        giveBack(space);
      }
      // The person's own ship is drawn over the scene; the scene's parked rocket stays out of the way.
      space.script.shipScale(0);

      // A star or anything below it shows its own system alone once the camera has nearly arrived, and keeps it alone
      // for the first part of a flight away, so the other systems come in as the camera climbs and not at once.
      const keptAlone = leaving !== null && leaving.stop !== 'universe' && q < 0.4 ? leaving.systemId : null;
      const alone = control.target.stop !== 'universe' && q > 0.6 ? control.target.systemId : keptAlone;
      space.showOnly(alone);
      return lastPose;
    },
    render(renderer, size) {
      const ship = control.afterFrame?.({ dt: lastDt, flying: flight !== null, globe: globeScreen, size }) ?? null;
      if (ship === null || ship.alpha <= 0.02) return;
      // The ship sits over the scene in screen space, so it is drawn last on top of what is there.
      shipLayer.resize(size.width, size.height);
      shipLayer.draw(ship, lastT ?? 0);
      renderer.autoClear = false;
      renderer.clearDepth();
      renderer.render(shipLayer.scene, shipLayer.camera);
      renderer.autoClear = true;
    },
    anchors(space, size) {
      const planet = worldPlanet();
      if (planet === null || !globe.mesh.visible || globeScreen === null || globeScreen.radiusPx < 90) return [];
      space.camera.updateMatrixWorld();
      globe.mesh.updateMatrixWorld();
      const anchors: SpaceAnchor[] = [];
      for (const label of planet.labels) {
        const local = localPointOf(label.x, label.lat);
        const world = globe.mesh.localToWorld(local.clone());
        const normal = world.clone().sub(globe.mesh.position).normalize();
        const facing = normal.dot(scratch.copy(space.camera.position).sub(world).normalize());
        const point = world.clone().project(space.camera);
        anchors.push({
          id: label.objectId,
          kind: 'region',
          name: planet.names.get(label.objectId) ?? '',
          systemId: control.target.systemId,
          x: (point.x * 0.5 + 0.5) * size.width,
          y: (-point.y * 0.5 + 0.5) * size.height,
          radiusPx: 0,
          visible: facing > 0.25 && point.z < 1,
        });
      }
      return anchors;
    },
    dispose() {
      attachedTo?.scene.remove(globe.mesh);
      globe.dispose();
      shipLayer.dispose();
    },
  };
}
