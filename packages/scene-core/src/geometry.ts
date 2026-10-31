import { SceneDescriptorSchema, SceneParseError } from './parse.js';
import { seedState, variation } from './seed.js';
import { sineSample } from './unit-circle.js';
import type { SceneFamily, SceneGeometry } from './types.js';

export interface SceneGeometryOptions {
  detail: 'full' | 'low';
  reducedMotion: boolean;
}
const FAMILIES: Readonly<Record<SceneFamily, { radius: number; lobes: number; amplitude: number }>> = {
  'terraced.v1': { radius: 52, lobes: 4, amplitude: 0.07 },
  'ridged.v1': { radius: 60, lobes: 7, amplitude: 0.13 },
  'archipelago.v1': { radius: 56, lobes: 3, amplitude: 0.18 },
};
function rounded(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
/**
 * Pure local geometry in descriptor coordinates. Persist the descriptor, not a sorted sibling
 * index. Detail removes vertices only; IDs, anchors, radius and navigation remain identical.
 * The fixed family sets size. Activity can only suggest motion and never changes the surface.
 */
export function buildSceneGeometry(input: unknown, options: SceneGeometryOptions): SceneGeometry {
  const descriptor = SceneDescriptorSchema.parse(input);
  // Inspect descriptors so even malformed JS option objects cannot invoke getters/functions.
  if (
    options === null ||
    typeof options !== 'object' ||
    Object.getPrototypeOf(options) !== Object.prototype ||
    Reflect.ownKeys(options).length !== 2
  )
    throw new SceneParseError();
  const detail = Object.getOwnPropertyDescriptor(options, 'detail');
  const reduced = Object.getOwnPropertyDescriptor(options, 'reducedMotion');
  if (
    !detail ||
    !('value' in detail) ||
    !['full', 'low'].includes(detail.value as string) ||
    !reduced ||
    !('value' in reduced) ||
    typeof reduced.value !== 'boolean'
  )
    throw new SceneParseError();
  const family = FAMILIES[descriptor.family];
  const state = seedState(descriptor.seed);
  const coarseAmplitude = 0.025 + variation(state, 0) * 0.02;
  const finePhase = Math.floor(variation(state, 1) * 64);
  const points = detail.value === 'full' ? 64 : 16;
  const silhouette = Array.from({ length: points }, (_, index) => {
    const sample = index * (64 / points);
    const base = family.amplitude * sineSample(family.lobes * sample);
    const coarse = coarseAmplitude * sineSample(2 * sample);
    const fine = descriptor.detail.roughness * 0.025 * sineSample(11 * sample + finePhase);
    const radius = family.radius * (1 + base + coarse + fine);
    return { x: rounded(radius * sineSample(sample + 16)), y: rounded(radius * sineSample(sample)) };
  });
  return {
    objectId: descriptor.objectId,
    parentId: descriptor.parentId,
    originTransitionId: descriptor.originTransitionId,
    generatorVersion: descriptor.generatorVersion,
    target: descriptor.target,
    anchor: descriptor.anchor,
    label: descriptor.label,
    truthStatus: descriptor.truthStatus,
    activity: descriptor.activity,
    palette: descriptor.palette,
    material: descriptor.material,
    radius: family.radius,
    silhouette,
    atmosphereRadius: rounded(family.radius * (1 + descriptor.atmosphere.density * 0.45)),
    motion:
      !reduced.value && descriptor.activity.availability === 'available' && descriptor.activity.state === 'active'
        ? 'gentle'
        : 'still',
  };
}
