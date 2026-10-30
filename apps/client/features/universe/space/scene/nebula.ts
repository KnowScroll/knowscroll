import * as THREE from 'three';
import { hexToUnit, seededRandom, TAU } from '../paint';
import { additive, type Built, type SceneContext } from './context';
import { makeHalo } from './halo';
import { NEBULA_FRAGMENT, NEBULA_VERTEX } from './shaders';

const CANDY = ['#FF7AD9', '#C58BFF', '#EBAAFF'].map(hexToUnit);
const ARMS = 5;

/** Per-dot attributes of a nebula; the same seed gives the same dust. */
function dustGeometry(dotCount: number, seed: string): THREE.BufferGeometry {
  const random = seededRandom(seed);
  const radius = new Float32Array(dotCount);
  const arm = new Float32Array(dotCount);
  const jitter = new Float32Array(dotCount);
  const size = new Float32Array(dotCount);
  const height = new Float32Array(dotCount);
  const colour = new Float32Array(dotCount * 3);
  for (let i = 0; i < dotCount; i++) {
    radius[i] = random();
    arm[i] = Math.floor(random() * ARMS);
    jitter[i] = (random() - 0.5) * (random() < 0.88 ? 0.32 : 1.6);
    size[i] = 0.7 + Math.pow(random(), 3) * 3.2;
    height[i] = (random() - 0.5) * 0.14;
    colour.set(CANDY[Math.floor(random() * CANDY.length)]!, i * 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(dotCount * 3), 3));
  geometry.setAttribute('aRho', new THREE.BufferAttribute(radius, 1));
  geometry.setAttribute('aArm', new THREE.BufferAttribute(arm, 1));
  geometry.setAttribute('aJit', new THREE.BufferAttribute(jitter, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aH', new THREE.BufferAttribute(height, 1));
  geometry.setAttribute('aCol', new THREE.BufferAttribute(colour, 3));
  return geometry;
}

interface Puff {
  readonly sprite: THREE.Sprite;
  readonly rho: number;
  readonly arm: number;
  readonly jitter: number;
  readonly size: number;
}

function makePuffs(count: number, radius: number, seed: string, context: SceneContext, parent: THREE.Group): Puff[] {
  const random = seededRandom(seed + 'puffs');
  return Array.from({ length: count }, () => {
    const [red, green, blue] = CANDY[Math.floor(random() * 2)]!;
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: context.sprites.puff,
        color: new THREE.Color(red, green, blue),
        opacity: 0.34,
        ...additive,
      }),
    );
    sprite.material.rotation = random() * TAU;
    parent.add(sprite);
    return {
      sprite,
      rho: 0.22 + random() * 0.6,
      arm: Math.floor(random() * ARMS),
      jitter: (random() - 0.5) * 0.12,
      size: (0.12 + random() * 0.12) * radius,
    };
  });
}

/**
 * The cartoon nebula (U01 Emerging, and the faint cue in the Overview): candy-coloured dots and
 * puffs spiralling inward along five arms toward a pulsing core. It is dust, not a place.
 */
export function makeNebula(
  radius: number,
  dotCount: number,
  seed: string,
  context: SceneContext,
  puffCount = 22,
): Built {
  const group = new THREE.Group();
  const dots = new THREE.Points(
    dustGeometry(dotCount, seed),
    new THREE.ShaderMaterial({
      vertexShader: NEBULA_VERTEX,
      fragmentShader: NEBULA_FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: {
        time: context.time,
        R: { value: radius },
        pr: context.pixelRatio,
        arms: { value: ARMS },
      },
    }),
  );
  dots.frustumCulled = false;
  group.add(makeHalo(radius * 1.15, 'pink', context, 0.35), dots);
  const puffs = makePuffs(puffCount, radius, seed, context, group);
  const core = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.glow,
      color: new THREE.Color(1, 0.92, 0.98),
      opacity: 1,
      ...additive,
    }),
  );
  const bloom = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.bloom,
      color: new THREE.Color(1, 0.45, 0.85),
      opacity: 0.8,
      ...additive,
    }),
  );
  group.add(bloom, core);

  const tick = (t: number): void => {
    for (const puff of puffs) {
      const angle = (puff.arm * TAU) / ARMS + Math.log(puff.rho / 0.05) * 1.25 + t * 0.2 + puff.jitter;
      puff.sprite.position.set(Math.cos(angle) * puff.rho * radius, 0, Math.sin(angle) * puff.rho * radius);
      puff.sprite.scale.setScalar(puff.size * (1 + 0.06 * Math.sin(t + puff.rho * 9)));
    }
    const beat = 1 + 0.12 * Math.sin(t * 2.2);
    core.scale.setScalar(radius * 0.24 * beat);
    bloom.scale.setScalar(radius * 0.9 * (2 - beat));
  };
  tick(0);
  return { object: group, tick };
}
