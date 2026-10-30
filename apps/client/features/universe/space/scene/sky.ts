import * as THREE from 'three';
import { seededRandom, TAU } from '../paint';
import { additive, type SceneContext } from './context';
import { STAR_FRAGMENT, STAR_VERTEX } from './shaders';

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
    new THREE.ShaderMaterial({ vertexShader: STAR_VERTEX, fragmentShader: STAR_FRAGMENT, ...additive, uniforms }),
  );
  points.frustumCulled = false;
  return points;
}

/** Adds the star shells and a few near motes around `cameraPosition` to `scene`. */
export function addSky(scene: THREE.Scene, seed: string, context: SceneContext, cameraPosition: THREE.Vector3): void {
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
  scene.add(starPoints(motes, random, uniforms({ atten: 6, wob: 0.8, opacity: 0.8 })));
}
