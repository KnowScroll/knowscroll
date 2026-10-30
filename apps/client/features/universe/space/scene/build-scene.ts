import * as THREE from 'three';
import type { PixelImage } from '../texture-data';
import { planetGenome } from '../planet-genome';
import type { SpaceCameraDefinition, SpaceDefinition, SpaceSystemDefinition } from '../space-definition';
import { createSpriteTextures, pixelTexture, type Built, type SceneContext } from './context';
import { makeHalo } from './halo';
import { makeNebula } from './nebula';
import { makePlanet } from './planet';
import { addSky } from './sky';
import { makeSun } from './sun';

/** A point of the scene that a label or tap target follows. */
export interface WorldAnchor {
  readonly id: string;
  readonly kind: 'system' | 'planet';
  readonly name: string;
  readonly object: THREE.Object3D;
}

export interface BuiltSpace {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly pixelRatio: { value: number };
  readonly anchors: readonly WorldAnchor[];
  /** Poses the whole scene at time `t`. Calling it twice with the same `t` gives the same picture. */
  readonly poseAt: (t: number) => void;
  /** Releases textures, geometries and materials. */
  readonly dispose: () => void;
}

/** Vertical field of view of every space view (design: 38 degrees). */
const FIELD_OF_VIEW = 38;

/** The camera breathes slowly; its pose is a pure function of `t`. */
function poseCamera(camera: THREE.PerspectiveCamera, definition: SpaceCameraDefinition, t: number): void {
  const [x, y, z] = definition.position;
  camera.position.set(
    x + Math.sin(t * 0.11) * 0.6 * definition.drift,
    y + Math.sin(t * 0.07) * 0.4 * definition.drift,
    z + Math.sin(t * 0.05) * 0.5 * definition.drift,
  );
  camera.lookAt(new THREE.Vector3(...definition.target));
}

/** Angular speed of a planet: inner planets turn faster. */
function orbitSpeed(system: SpaceSystemDefinition, orbitRadius: number): number {
  const innermost = Math.min(...system.planets.map((planet) => planet.orbitRadius));
  return system.speed * Math.pow(innermost / orbitRadius, system.orbitFalloff);
}

interface SystemBuild {
  readonly built: Built;
  readonly anchors: WorldAnchor[];
}

function buildSystem(system: SpaceSystemDefinition, context: SceneContext): SystemBuild {
  const group = new THREE.Group();
  group.position.set(system.position.x, 0, system.position.z);
  const sunPosition = group.position.clone();
  const outer = Math.max(...system.planets.map((planet) => planet.orbitRadius));
  group.add(makeHalo(outer * 1.5, system.family, context, 0.55));
  const sun = makeSun(system.sunRadius, context);
  group.add(sun.object);
  const anchors: WorldAnchor[] = [{ id: system.id, kind: 'system', name: system.name, object: sun.object }];

  const orbiting = system.planets.map((definition) => {
    const genome = planetGenome(definition.id, definition.type, system.family, {
      rings: definition.rings === true,
      moon: definition.moon === true,
    });
    const planet = makePlanet(
      genome,
      Math.min(system.planetRadius * genome.size, system.sunRadius * 0.55),
      sunPosition,
      context,
    );
    const pivot = new THREE.Group();
    planet.object.position.set(definition.orbitRadius, 0, 0);
    pivot.add(planet.object);
    group.add(pivot);
    anchors.push({ id: definition.id, kind: 'planet', name: definition.name, object: planet.object });
    return { definition, planet, pivot, speed: orbitSpeed(system, definition.orbitRadius) };
  });

  const tick = (t: number): void => {
    sun.tick(t);
    for (const { definition, planet, pivot, speed } of orbiting) {
      pivot.rotation.y = -(definition.startAngle + t * speed);
      planet.tick(t);
    }
  };
  tick(0);
  return { built: { object: group, tick }, anchors };
}

/**
 * Builds the scene of a space view from its definition: stars, systems with their suns, haze and
 * revolving planets, and a nebula of dust. Nothing here talks to the GPU until a renderer draws it.
 */
export function buildSpace(definition: SpaceDefinition, aspect: number, pixelRatio: number): BuiltSpace {
  const textures: THREE.Texture[] = [];
  const trackTexture = (image: PixelImage): THREE.DataTexture => {
    const texture = pixelTexture(image);
    textures.push(texture);
    return texture;
  };
  const context: SceneContext = {
    time: { value: 0 },
    pixelRatio: { value: pixelRatio },
    fogRange: definition.camera.fogRange,
    calm: false,
    sprites: createSpriteTextures(trackTexture),
    trackTexture,
  };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, aspect, 0.1, 3000);
  addSky(scene, 'sky', context, new THREE.Vector3(...definition.camera.position));

  const ticks: ((t: number) => void)[] = [];
  const anchors: WorldAnchor[] = [];
  for (const system of definition.systems) {
    const { built, anchors: systemAnchors } = buildSystem(system, context);
    scene.add(built.object);
    ticks.push(built.tick);
    anchors.push(...systemAnchors);
  }
  if (definition.nebula !== undefined) {
    const { x, y, z, radius } = definition.nebula;
    const nebula = makeNebula(radius, 900, 'dust', context, 10);
    nebula.object.position.set(x, y, z);
    scene.add(nebula.object);
    ticks.push(nebula.tick);
  }

  return {
    scene,
    camera,
    pixelRatio: context.pixelRatio,
    anchors,
    poseAt(t) {
      context.time.value = t;
      for (const tick of ticks) tick(t);
      poseCamera(camera, definition.camera, t);
    },
    dispose() {
      scene.traverse((node) => {
        const drawable = node as Partial<THREE.Mesh>;
        drawable.geometry?.dispose();
        const material = drawable.material;
        for (const entry of Array.isArray(material) ? material : material ? [material] : []) entry.dispose();
      });
      for (const texture of textures) texture.dispose();
    },
  };
}
