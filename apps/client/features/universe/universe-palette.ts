import { family, space } from '@knowscroll/design-tokens';
import type { ScenePalette } from '@knowscroll/scene-core';

/** Colours of a planet's disc: ocean gradient, the land's layered tones and the rim. */
export interface BodyColours {
  readonly oceanLight: string;
  readonly oceanMid: string;
  readonly oceanDeep: string;
  readonly glow: string;
  readonly land: string;
  readonly landMid: string;
  readonly landLight: string;
  readonly landCore: string;
  readonly stroke: string;
}

/**
 * The scene's three palettes. The projector picks the palette from the silhouette family, so these
 * are cosmetic families (teal with green land, cobalt with pale strata, amber with dune ridges)
 * and never say anything about how much was read.
 */
export const BODY_COLOURS: Readonly<Record<ScenePalette, BodyColours>> = {
  sage: {
    oceanLight: '#5FE0CF',
    oceanMid: '#22A99E',
    oceanDeep: '#11706B',
    glow: '#5FE0CF',
    land: family.learningMachines.pattern,
    landMid: '#7DDB8A',
    landLight: '#A6E8A8',
    landCore: '#CFF3C8',
    stroke: family.learningMachines.stroke,
  },
  cobalt: {
    oceanLight: '#9CB0FF',
    oceanMid: family.systems.base,
    oceanDeep: '#3A4FC4',
    glow: '#9CB0FF',
    land: family.systems.pattern,
    landMid: '#DCE2FF',
    landLight: '#EBEEFF',
    landCore: '#F7F8FF',
    stroke: '#1F2A7A',
  },
  ochre: {
    oceanLight: '#FFD98A',
    oceanMid: family.past.base,
    oceanDeep: '#B87A12',
    glow: '#FFD98A',
    land: '#C27B1C',
    landMid: '#D9993A',
    landLight: '#EDB964',
    landCore: '#F7D58E',
    stroke: family.past.stroke,
  },
};

const channel = (hex: string, index: number) => Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
const toHex = (value: number) => Math.round(value).toString(16).padStart(2, '0');

/** Pulls a colour toward its own grey (the calm look: same place, quieter). */
export function calmer(hex: string, amount = 0.35): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const [red, green, blue] = [channel(hex, 0), channel(hex, 1), channel(hex, 2)];
  const grey = red * 0.3 + green * 0.59 + blue * 0.11;
  const mix = (value: number) => value + (grey - value) * amount;
  return `#${toHex(mix(red))}${toHex(mix(green))}${toHex(mix(blue))}`;
}

export function calmColours(colours: BodyColours): BodyColours {
  return Object.fromEntries(
    Object.entries(colours).map(([key, value]) => [key, calmer(value)]),
  ) as unknown as BodyColours;
}

export const STAR_COLOUR = space.star;
