import * as THREE from 'three';
import { seededRandom, TAU } from '../paint';
import { additive, type SceneContext } from './context';
import { SKY_LENSES, STAR_FRAGMENT, STAR_LENSED_VERTEX, STAR_VERTEX } from './shaders';

interface StarShell {
  readonly count: number;
  readonly distance: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly brightness: number;
}

/** Three shells of stars that drift against each other as the camera breathes. */
const SHELLS: readonly StarShell[] = [
  { count: 1600, distance: 900, minSize: 1.6, maxSize: 2.6, brightness: 1 },
  { count: 520, distance: 480, minSize: 2.1, maxSize: 3.2, brightness: 1.2 },
  { count: 140, distance: 240, minSize: 2.8, maxSize: 4.4, brightness: 1.4 },
];

interface StarSample {
  readonly position: readonly [number, number, number];
  readonly size: number;
  readonly colour: readonly [number, number, number];
}

function starPoints(
  samples: readonly StarSample[],
  random: () => number,
  uniforms: Record<string, THREE.IUniform>,
  vertexShader: string = STAR_VERTEX,
): THREE.Points {
  const position = new Float32Array(samples.length * 3);
  const size = new Float32Array(samples.length);
  const colour = new Float32Array(samples.length * 3);
  const phase = new Float32Array(samples.length);
  samples.forEach((sample, index) => {
    position.set(sample.position, index * 3);
    size[index] = sample.size;
    colour.set(sample.colour, index * 3);
    phase[index] = random();
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aCol', new THREE.BufferAttribute(colour, 3));
  geometry.setAttribute('aPh', new THREE.BufferAttribute(phase, 1));
  const points = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({ vertexShader, fragmentShader: STAR_FRAGMENT, ...additive, uniforms }),
  );
  points.frustumCulled = false;
  return points;
}

/**
 * Adds the star shells and a few near motes around `cameraPosition` to `scene`. Returns the shells: the stars far
 * behind everything, which a view may bend round the bodies in front of them ({@link bendSky}).
 */
export function addSky(
  scene: THREE.Object3D,
  seed: string,
  context: SceneContext,
  cameraPosition: THREE.Vector3,
): readonly THREE.Points[] {
  const shells: THREE.Points[] = [];
  const random = seededRandom(seed);
  const uniforms = (extra: { atten?: number; wob?: number; opacity?: number }): Record<string, THREE.IUniform> => ({
    time: context.time,
    pr: context.pixelRatio,
    atten: { value: extra.atten ?? 0 },
    wob: { value: extra.wob ?? 0 },
    opacity: { value: extra.opacity ?? 1 },
  });
  const tint = (): readonly [number, number, number] => {
    const pick = random();
    return pick < 0.15 ? [1, 0.86, 0.7] : pick < 0.3 ? [0.75, 0.85, 1] : [1, 1, 1];
  };

  for (const shell of SHELLS) {
    const samples = Array.from({ length: shell.count }, (): StarSample => {
      const up = random() * 2 - 1;
      const around = random() * TAU;
      const ring = Math.sqrt(1 - up * up);
      const reach = shell.distance * (0.9 + random() * 0.2);
      const brightness = (0.35 + random() * 0.65) * shell.brightness;
      const [red, green, blue] = tint();
      return {
        position: [ring * Math.cos(around) * reach, up * reach, ring * Math.sin(around) * reach],
        size: shell.minSize + Math.pow(random(), 3) * (shell.maxSize - shell.minSize),
        colour: [red * brightness, green * brightness, blue * brightness],
      };
    });
    const points = starPoints(samples, random, uniforms({}));
    shells.push(points);
    scene.add(points);
  }

  const motes = Array.from({ length: 46 }, (): StarSample => {
    const glow = 0.25 + random() * 0.3;
    return {
      position: [
        cameraPosition.x + (random() - 0.5) * 26,
        cameraPosition.y + (random() - 0.5) * 18 - 2,
        cameraPosition.z - 6 - random() * 22,
      ],
      size: 3 + random() * 6,
      colour: [0.55 * glow, 0.6 * glow, 0.8 * glow],
    };
  });
  scene.add(starPoints(motes, random, uniforms({ atten: 6, wob: 0.8, opacity: 0.8 })));
  return shells;
}

/** A body that bends the stars behind it: where it is on screen (y down, as layout is) and its lens radius, in layout points. */
export interface SkyLens {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** The background stars, bent: tells them which bodies bend them this frame. */
export interface BentSky {
  /** At most `SKY_LENSES` lenses (the rest are dropped); `view` is the view's size in layout points. */
  set(lenses: readonly SkyLens[], view: { readonly width: number; readonly height: number }): void;
  /** Puts the shells' own straight material back and frees the bent one. */
  dispose(): void;
}

/**
 * The deep field: many faint small stars far behind everything, as dense as the design's sky. Only the bent sky has it,
 * so the shipping map keeps the sky it has; it also gives a bend something to show, since the shells alone leave a few
 * stars round any one body.
 */
const DEEP_FIELD = { count: 40000, distance: 1000, minSize: 1.1, maxSize: 2, brightness: 0.6 } as const;

/**
 * Draws `shells` with {@link STAR_LENSED_VERTEX} instead of their own vertex shader, sharing their uniforms, and adds
 * the deep field under `group`, so the stars behind a body bend round it. Its program is linked on the next draw, so
 * call it when a view starts, never during a flight.
 */
export function bendSky(shells: readonly THREE.Points[], group: THREE.Object3D, context: SceneContext): BentSky {
  const lenses = Array.from({ length: SKY_LENSES }, () => new THREE.Vector4(0, 0, 0, 0));
  const view = new THREE.Vector2(1, 1);
  const bend = { lenses: { value: lenses }, view: { value: view } };
  const swapped = shells.map((points) => {
    const straight = points.material as THREE.ShaderMaterial;
    const bent = new THREE.ShaderMaterial({
      vertexShader: STAR_LENSED_VERTEX,
      fragmentShader: STAR_FRAGMENT,
      ...additive,
      uniforms: { ...straight.uniforms, ...bend },
    });
    points.material = bent;
    return { points, straight, bent };
  });
  const random = seededRandom('deep-field');
  const deep = starPoints(
    Array.from({ length: DEEP_FIELD.count }, (): StarSample => {
      const up = random() * 2 - 1;
      const around = random() * TAU;
      const ring = Math.sqrt(1 - up * up);
      const reach = DEEP_FIELD.distance * (0.95 + random() * 0.1);
      const glow = (0.25 + random() * 0.75) * DEEP_FIELD.brightness;
      const cool = random() < 0.25;
      return {
        position: [ring * Math.cos(around) * reach, up * reach, ring * Math.sin(around) * reach],
        size: DEEP_FIELD.minSize + random() * (DEEP_FIELD.maxSize - DEEP_FIELD.minSize),
        colour: cool ? [0.75 * glow, 0.85 * glow, glow] : [glow, glow, glow],
      };
    }),
    random,
    {
      time: context.time,
      pr: context.pixelRatio,
      atten: { value: 0 },
      wob: { value: 0 },
      opacity: { value: 1 },
      ...bend,
    },
    STAR_LENSED_VERTEX,
  );
  deep.name = 'deep-field';
  group.add(deep);
  return {
    set(next, size) {
      view.set(Math.max(1, size.width), Math.max(1, size.height));
      // The shader measures from the bottom of the view (y up, as clip space is); layout measures from the top.
      const height = Math.max(1, size.height);
      lenses.forEach((lens, index) => {
        const from = next[index];
        lens.set(from?.x ?? 0, from === undefined ? 0 : height - from.y, from?.radius ?? 0, 0);
      });
    },
    dispose() {
      for (const { points, straight, bent } of swapped) {
        points.material = straight;
        bent.dispose();
      }
      group.remove(deep);
      deep.geometry.dispose();
      (deep.material as THREE.Material).dispose();
    },
  };
}
