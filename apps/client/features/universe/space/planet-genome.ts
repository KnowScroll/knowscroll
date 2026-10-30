import { seededRandom } from './paint';

/** The painted biomes of the design (Foundations, "Planet types"). */
export type PlanetType = 'lush' | 'ocean' | 'frozen' | 'scorched' | 'barren' | 'gas';

/** The system haze families (they tint the haze around a sun, never the sun itself). */
export type HazeFamily = 'teal' | 'cobalt' | 'coral' | 'amber' | 'pink' | 'violet';

/** Hue shift a haze family gives to the planets of its system. */
const FAMILY_HUE_SHIFT: Readonly<Record<HazeFamily, number>> = {
  teal: 0,
  cobalt: 18,
  coral: -18,
  amber: -10,
  pink: 25,
  violet: 30,
};

/** Everything the renderer needs to paint one planet. */
export interface PlanetGenome {
  readonly id: string;
  readonly type: PlanetType;
  /** Hue shift in degrees. */
  readonly hueShift: number;
  /** Relative size, 0.8 to 1.3. Derived from the seed only, never from activity. */
  readonly size: number;
  /** Axis tilt in radians. */
  readonly tilt: number;
  /** Spin rate in radians per second. */
  readonly spin: number;
  readonly rings: boolean;
  readonly moon: boolean;
}

/**
 * The look of a planet from its stable id, chosen type and system haze family. The same inputs give
 * the same planet on every device. Assigning types so that they do not repeat is the server's job
 * in a later slice; this function only paints the type it is given.
 */
export function planetGenome(
  id: string,
  type: PlanetType,
  family: HazeFamily,
  overrides: Partial<Pick<PlanetGenome, 'rings' | 'moon'>> = {},
): PlanetGenome {
  const random = seededRandom(id);
  const hueShift = FAMILY_HUE_SHIFT[family] + (random() - 0.5) * 30;
  const size = 0.8 + random() * 0.5;
  const tilt = (random() - 0.5) * 0.7;
  const spin = 0.12 + random() * 0.12;
  const ringsDrawn = type === 'gas' || (type === 'frozen' && random() < 0.5);
  const moonDrawn = random() < 0.45;
  return {
    id,
    type,
    hueShift,
    size,
    tilt,
    spin,
    rings: overrides.rings ?? ringsDrawn,
    moon: overrides.moon ?? moonDrawn,
  };
}
