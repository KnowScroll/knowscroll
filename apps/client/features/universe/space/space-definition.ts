import type { RoomKit } from '@knowscroll/contracts';
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
  /** The server's hue turn for this planet, in degrees (D-103). Absent: the haze family's lean. */
  readonly hueShift?: number;
  /** The planets of its type before this one; a repeated type paints a different world. */
  readonly variant?: number;
  /** Quiet under the Lately lens: drawn grey and dim. */
  readonly calm?: boolean;
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
  /** Quiet under the Lately lens: no bloom, grey planets. */
  readonly calm?: boolean;
}

/** What a station draws of its room's face (D-170): the emblem and the kit's palette, as the room's band does. */
export type StationEmblem = Pick<RoomKit, 'emblem' | 'palette'>;

/** A room's station, beside the system (or planet) of its topic. */
export interface SpaceStationDefinition {
  readonly id: string;
  readonly name: string;
  readonly systemId: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly calm?: boolean;
  /** The room's emblem, drawn on the station; absent for a room whose server sent no face. */
  readonly emblem?: StationEmblem;
}

/** A cloud of dust: recent reading that has not formed a place. Never a place, never named. */
export interface SpaceDustDefinition {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly radius: number;
  readonly dots: number;
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

/** What a space view shows: systems, stations, a ship parked on a planet and clouds of dust. */
export interface SpaceDefinition {
  /** The pose the scene starts in, before the camera rig takes over. */
  readonly camera: SpaceCameraDefinition;
  readonly systems: readonly SpaceSystemDefinition[];
  readonly stations?: readonly SpaceStationDefinition[];
  readonly dust?: readonly SpaceDustDefinition[];
  /** The planet the ship is parked at (device-local, D-080). */
  readonly shipPlanetId?: string;
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
  dust: [{ id: 'sample-dust', position: { x: -11, y: 0.5, z: -14 }, radius: 3.4, dots: 900 }],
};
