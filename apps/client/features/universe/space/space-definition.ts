import type { HazeFamily, PlanetType } from './planet-genome';

/** One planet of a space view. Positions and names are the same in the 3D drawing and the Simple lists. */
export interface SpacePlanetDefinition {
  readonly id: string;
  readonly name: string;
  readonly type: PlanetType;
  /** Distance from the sun in scene units. */
  readonly orbitRadius: number;
  /** Where on the orbit the planet starts, in radians. */
  readonly startAngle: number;
  readonly rings?: boolean;
  readonly moon?: boolean;
}

/** A sun and the planets that revolve around it (no orbit lines are drawn). */
export interface SpaceSystemDefinition {
  readonly id: string;
  readonly name: string;
  readonly family: HazeFamily;
  readonly position: { readonly x: number; readonly z: number };
  readonly sunRadius: number;
  readonly planetRadius: number;
  /** Angular speed of the innermost planet, radians per second. */
  readonly speed: number;
  /** How fast outer planets slow down: speed falls with (inner radius / radius) to this power. */
  readonly orbitFalloff: number;
  readonly planets: readonly SpacePlanetDefinition[];
}

/** Where the camera stands and how far things fade into the sky. */
export interface SpaceCameraDefinition {
  readonly position: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  /** How far the camera breathes around its position. */
  readonly drift: number;
  readonly fogRange: readonly [number, number];
}

/** The v2.1 "System" camera: one sun and its planets fill the view. */
const SYSTEM_CAMERA: SpaceCameraDefinition = {
  position: [0, 34, 52],
  target: [0, -0.6, 0],
  drift: 0.6,
  fogRange: [70, 150],
};

/** What a space view shows: systems, and optionally one nebula of dust. */
export interface SpaceDefinition {
  readonly camera: SpaceCameraDefinition;
  readonly systems: readonly SpaceSystemDefinition[];
  readonly nebula?: { readonly x: number; readonly y: number; readonly z: number; readonly radius: number };
}

/**
 * The renderer gate's sample scene: one system, two planets and a nebula cue, laid out like the
 * v2.1 "System" frame (U02). A labelled sample for the developer gallery, never product data.
 */
export const SAMPLE_SPACE: SpaceDefinition = {
  camera: SYSTEM_CAMERA,
  systems: [
    {
      id: 'sample-system',
      name: 'Sample system',
      family: 'teal',
      position: { x: 0, z: 0 },
      sunRadius: 1.7,
      planetRadius: 0.55,
      speed: 0.07,
      orbitFalloff: 0.5,
      planets: [
        {
          id: 'sample-planet-one',
          name: 'First sample planet',
          type: 'lush',
          orbitRadius: 3.8,
          startAngle: 3,
          moon: true,
        },
        {
          id: 'sample-planet-two',
          name: 'Second sample planet',
          type: 'gas',
          orbitRadius: 6.3,
          startAngle: 0.35,
          rings: true,
        },
      ],
    },
  ],
  nebula: { x: -11, y: 0.5, z: -14, radius: 3.4 },
};
