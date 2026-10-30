import * as THREE from 'three';
import { seededRandom, TAU } from '../paint';
import type { PlanetGenome } from '../planet-genome';
import { paintPlanet, type PlanetPixels } from '../texture-data';
import {
  additive,
  hazeUniforms,
  SKY_COLOUR,
  unitColour,
  type Built,
  type PaintCache,
  type SceneContext,
} from './context';
import { ATMOSPHERE_FRAGMENT, PLANET_FRAGMENT, RING_FRAGMENT, RING_VERTEX, WORLD_VERTEX } from './shaders';

/** How many painted planets a scene's cache keeps. */
const PAINTED_LIMIT = 64;

/**
 * Painting a planet takes a few milliseconds; the Lately lens and new places rebuild the scene, so the
 * pixels of a planet already painted are kept in the renderer's own cache (a planet is a pure function
 * of its genome). The cache belongs to one renderer and goes with it: nothing outlives the screen.
 */
function paintOnce(genome: PlanetGenome, painted: PaintCache): PlanetPixels {
  const key = [genome.id, genome.type, genome.hueShift, genome.rings, genome.moon].join('|');
  const known = painted.get(key);
  if (known !== undefined) return known;
  const pixels = paintPlanet(genome);
  if (painted.size >= PAINTED_LIMIT) painted.delete(painted.keys().next().value!);
  painted.set(key, pixels);
  return pixels;
}

function surfaceMaterial(
  context: SceneContext,
  map: THREE.Texture,
  sun: THREE.Vector3,
  atmosphere: THREE.Vector3,
  cloudLayer: boolean,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: WORLD_VERTEX,
    fragmentShader: PLANET_FRAGMENT,
    transparent: cloudLayer,
    depthWrite: !cloudLayer,
    uniforms: {
      map: { value: map },
      sun: { value: sun },
      atmo: { value: atmosphere },
      cloudLayer: { value: cloudLayer ? 1 : 0 },
      ...hazeUniforms(context),
    },
  });
}

function atmosphereShell(radius: number, sun: THREE.Vector3, colour: THREE.Vector3, context: SceneContext): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius * 1.32, 40, 20),
    new THREE.ShaderMaterial({
      vertexShader: WORLD_VERTEX,
      fragmentShader: ATMOSPHERE_FRAGMENT,
      ...additive,
      uniforms: {
        color: { value: colour },
        sun: { value: sun },
        strength: { value: 1.15 },
        calm: { value: context.calm ? 1 : 0 },
        fogCol: { value: SKY_COLOUR },
        fogR: { value: context.fog },
      },
    }),
  );
}

function ringMesh(
  radius: number,
  genome: PlanetGenome,
  strip: THREE.Texture,
  sun: THREE.Vector3,
  planetCentre: THREE.Vector3,
  context: SceneContext,
): THREE.Mesh {
  const inner = radius * 1.4;
  const outer = radius * 2.4;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, 96, 1),
    new THREE.ShaderMaterial({
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        map: { value: strip },
        sun: { value: sun },
        pc: { value: planetCentre },
        pr: { value: radius },
        rIn: { value: inner },
        rOut: { value: outer },
        ...hazeUniforms(context),
      },
    }),
  );
  ring.rotation.x = -Math.PI / 2 - 0.3;
  ring.rotation.y = genome.tilt * 0.5;
  return ring;
}

function makeMoon(genome: PlanetGenome, radius: number, sunPosition: THREE.Vector3, context: SceneContext): THREE.Mesh {
  const moon = paintOnce(
    { ...genome, id: genome.id + '-moon', type: 'barren', rings: false, moon: false },
    context.paintCache,
  );
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.27, 24, 12),
    surfaceMaterial(context, context.trackTexture(moon.surface), sunPosition, new THREE.Vector3(0.5, 0.45, 0.6), false),
  );
}

/**
 * A painted planet: surface, optional cloud layer, atmosphere rim, optional ring and optional
 * moon. Its spin and its moon's orbit are pure functions of `t`. `sunPosition` is the lit side.
 */
export function makePlanet(
  genome: PlanetGenome,
  radius: number,
  sunPosition: THREE.Vector3,
  context: SceneContext,
): Built {
  const pixels = paintOnce(genome, context.paintCache);
  const atmosphere = unitColour(pixels.atmosphere);
  const group = new THREE.Group();
  const spinner = new THREE.Group();
  spinner.rotation.z = genome.tilt;
  group.add(spinner);

  const body = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 48, 24),
    surfaceMaterial(context, context.trackTexture(pixels.surface), sunPosition, atmosphere, false),
  );
  spinner.add(body);
  let clouds: THREE.Mesh | null = null;
  if (pixels.clouds !== null) {
    clouds = new THREE.Mesh(
      new THREE.SphereGeometry(radius * 1.03, 40, 20),
      surfaceMaterial(context, context.trackTexture(pixels.clouds), sunPosition, atmosphere, true),
    );
    spinner.add(clouds);
  }
  group.add(atmosphereShell(radius, sunPosition, atmosphere, context));

  const centre = new THREE.Vector3();
  if (pixels.ring !== null) {
    group.add(ringMesh(radius, genome, context.trackTexture(pixels.ring), sunPosition, centre, context));
  }
  const moon = genome.moon ? makeMoon(genome, radius, sunPosition, context) : null;
  if (moon !== null) group.add(moon);

  const phase = seededRandom(genome.id)() * TAU;
  const tick = (t: number): void => {
    body.rotation.y = t * genome.spin;
    if (clouds !== null) clouds.rotation.y = t * genome.spin * 1.5 + 1;
    if (moon !== null) {
      const angle = t * 0.5 + phase;
      moon.position.set(Math.cos(angle) * radius * 2.4, Math.sin(angle) * radius * 0.4, Math.sin(angle) * radius * 2.4);
    }
    group.getWorldPosition(centre);
  };
  return { object: group, tick };
}
