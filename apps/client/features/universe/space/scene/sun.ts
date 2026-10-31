import * as THREE from 'three';
import { additive, hazeUniforms, type Built, type SceneContext } from './context';
import { SUN_FRAGMENT, WORLD_VERTEX } from './shaders';

/**
 * An orange sun with a pulsing haze. The sun is always orange (design rule 4); the system's haze
 * family colours only the halo around it. A quiet system dims the glow.
 */
/** A sun and the one thing a camera move may change about it: how much of its glow shows up close. */
export interface BuiltSun extends Built {
  /** Shares of the bloom and the inner glow that show; 1 and 1 at rest. */
  readonly setCloseUp: (bloom: number, glow: number) => void;
}

export function makeSun(radius: number, context: SceneContext): BuiltSun {
  const group = new THREE.Group();
  const glowScale = context.calm ? 0.22 : 1;
  const core = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 40, 20),
    new THREE.ShaderMaterial({
      vertexShader: WORLD_VERTEX,
      fragmentShader: SUN_FRAGMENT,
      uniforms: hazeUniforms(context),
    }),
  );
  const inner = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.glow,
      color: new THREE.Color(1, 0.72, 0.38),
      opacity: 0.95 * glowScale,
      ...additive,
    }),
  );
  const bloom = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: context.sprites.bloom,
      color: new THREE.Color(1, 0.45, 0.12),
      opacity: 0.85 * glowScale,
      ...additive,
    }),
  );
  group.add(bloom, inner, core);
  let bloomShare = 1;
  let glowShare = 1;
  const tick = (t: number): void => {
    const pulse = 1 + 0.05 * Math.sin(t * 1.3);
    inner.scale.setScalar(radius * 4.2 * pulse * glowShare);
    bloom.scale.setScalar(radius * 22 * (2 - pulse) * bloomShare);
  };
  tick(0);
  return {
    object: group,
    tick,
    setCloseUp(bloom, glow) {
      bloomShare = Math.max(bloom, 1e-3);
      glowShare = Math.max(glow, 1e-3);
    },
  };
}
