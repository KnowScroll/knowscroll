import * as THREE from 'three';
import { seededRandom, TAU } from '../paint';
import { additive, type SceneContext } from './context';
import { SMUDGE_FRAGMENT, SMUDGE_VERTEX, STAR_FRAGMENT, STAR_VERTEX } from './shaders';

interface StarShell {
  readonly count: number;
  readonly distance: number;
  readonly minSize: number;
  readonly maxSize: number;
  readonly brightness: number;
}

/** The name of the few near motes: they float among the bodies, so a view that splits the sky off leaves them with the bodies. */
const NEAR_MOTES = 'near-motes';

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
  shaders: { readonly vertex: string; readonly fragment: string } = { vertex: STAR_VERTEX, fragment: STAR_FRAGMENT },
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
    new THREE.ShaderMaterial({ vertexShader: shaders.vertex, fragmentShader: shaders.fragment, ...additive, uniforms }),
  );
  points.frustumCulled = false;
  return points;
}

/**
 * Adds the star shells and a few near motes around `cameraPosition` to `scene`.
 */
export function addSky(
  scene: THREE.Object3D,
  seed: string,
  context: SceneContext,
  cameraPosition: THREE.Vector3,
): void {
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
    scene.add(starPoints(samples, random, uniforms({})));
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
  const near = starPoints(motes, random, uniforms({ atten: 6, wob: 0.8, opacity: 0.8 }));
  near.name = NEAR_MOTES;
  scene.add(near);
}

/**
 * The three.js layer of the background: the star shells and the deep field. A view that bends the sky
 * ({@link splitSky}) draws this layer alone, apart from everything else; the shipping map never moves them off layer 0.
 */
export const BACKGROUND_LAYER = 1;

/**
 * The deep field: many faint small stars far behind everything, as dense as the design's sky. Only a split sky has it,
 * so the shipping map keeps the sky it has; it also gives a bend something to show, since the shells alone leave a few
 * stars round any one body.
 */
const DEEP_FIELD = { count: 40000, distance: 1000, minSize: 1.1, maxSize: 2, brightness: 0.6 } as const;
/** The deep field's far smudges: faint soft ovals, a few to a score of points long, which a bend stretches into arcs. */
const SMUDGES = { count: 12000, distance: 1000, minSize: 7, maxSize: 22, brightness: 0.36 } as const;

/**
 * Puts the star shells `group` holds ({@link addSky}; not the near motes, which float among the bodies) on {@link BACKGROUND_LAYER}, and adds the deep field there
 * too: the sky becomes drawable alone, so a view can bend it without touching the bodies in front of it. It does not
 * change how the stars are drawn. Calling it again changes nothing.
 */
export function splitSky(group: THREE.Object3D, context: SceneContext): void {
  if (group.getObjectByName('deep-field') !== undefined) return;
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
    },
  );
  deep.name = 'deep-field';
  group.add(deep);
  const smudges = starPoints(
    Array.from({ length: SMUDGES.count }, (): StarSample => {
      const up = random() * 2 - 1;
      const around = random() * TAU;
      const ring = Math.sqrt(1 - up * up);
      const reach = SMUDGES.distance * (0.95 + random() * 0.1);
      const glow = (0.3 + random() * 0.7) * SMUDGES.brightness;
      const warm = random() < 0.35;
      return {
        position: [ring * Math.cos(around) * reach, up * reach, ring * Math.sin(around) * reach],
        size: SMUDGES.minSize + Math.pow(random(), 2) * (SMUDGES.maxSize - SMUDGES.minSize),
        colour: warm ? [glow, 0.82 * glow, 0.62 * glow] : [0.7 * glow, 0.82 * glow, glow],
      };
    }),
    random,
    { time: context.time, pr: context.pixelRatio, opacity: { value: 1 } },
    { vertex: SMUDGE_VERTEX, fragment: SMUDGE_FRAGMENT },
  );
  smudges.name = 'deep-smudges';
  group.add(smudges);
  for (const object of group.children) if (object.name !== NEAR_MOTES) object.layers.set(BACKGROUND_LAYER);
}
