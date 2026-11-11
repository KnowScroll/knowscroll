import type { SpaceDefinition, SpaceSystemDefinition } from '../space-definition';
import type { HazeFamily, PlanetType } from '../planet-genome';

const HAZES: readonly HazeFamily[] = ['teal', 'cobalt', 'coral', 'amber', 'pink', 'violet'];
const TYPES: readonly PlanetType[] = ['lush', 'ocean', 'frozen', 'scorched', 'barren', 'gas'];

/**
 * CI-only: a map of `count` systems on a grid 9.6 scene units apart (the spacing of `canonical-lattice.v2`), each with
 * `planets` planets, for the tests and measurements of the level of detail. Authored, never product data.
 */
export function scaleDefinition(count: number, planets = 3): SpaceDefinition {
  const side = Math.ceil(Math.sqrt(count));
  const systems: SpaceSystemDefinition[] = Array.from({ length: count }, (_, n) => {
    const id = `sys-${n.toString().padStart(5, '0')}`;
    return {
      id,
      name: `System ${n}`,
      family: HAZES[n % HAZES.length]!,
      position: { x: ((n % side) - side / 2) * 9.6, z: (Math.floor(n / side) - side / 2) * 9.6 },
      sunRadius: 0.7 + (n % 5) * 0.03,
      planetRadius: 0.3,
      speed: 0.1,
      orbitFalloff: 0.8,
      planets: Array.from({ length: planets }, (_, k) => ({
        id: `${id}-p${k}`,
        name: `Planet ${n}.${k}`,
        type: TYPES[(n + k) % TYPES.length]!,
        orbitRadius: 1.5 + k * 0.65,
        startAngle: (k * Math.PI) / 2,
      })),
      ...(n % 7 === 0 ? { calm: true } : {}),
    };
  });
  return {
    camera: { position: [0, 22, 46], target: [0, 0, 2], drift: 0.9, fogRange: [46, 105] },
    systems,
  };
}
