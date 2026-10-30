import { clamp, fbm, hsl, mixRgb, ramp, seededRandom, smooth, TAU, type Rgb } from './paint';
import type { PlanetGenome, PlanetType } from './planet-genome';

/**
 * Pixel data for the painted textures of the space views. Plain typed arrays, so the same code
 * runs under Hermes (no canvas there) and in the browser, and a texture is a pure function of its
 * inputs. `scene/textures.ts` wraps these in three.js textures.
 */
export interface PixelImage {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

interface BiomeStyle {
  readonly ramp?: readonly Rgb[];
  readonly bands?: readonly Rgb[];
  readonly sea?: number;
  readonly atmosphere: Rgb;
  readonly clouds?: number;
}

const biomeStyle = (shift: number): Readonly<Record<PlanetType, BiomeStyle>> => ({
  lush: {
    ramp: [
      hsl(200 + shift, 70, 34),
      hsl(185 + shift, 75, 48),
      hsl(120 + shift, 55, 46),
      hsl(95 + shift, 65, 56),
      hsl(70 + shift, 70, 68),
    ],
    sea: 0.5,
    atmosphere: hsl(190 + shift, 95, 68),
    clouds: 0.8,
  },
  frozen: {
    ramp: [hsl(215 + shift, 50, 52), hsl(205 + shift, 55, 70), hsl(195 + shift, 50, 84), hsl(190 + shift, 40, 95)],
    atmosphere: hsl(195 + shift, 95, 78),
    clouds: 0.5,
  },
  scorched: {
    ramp: [hsl(345 + shift, 55, 24), hsl(355 + shift, 65, 36), hsl(10 + shift, 75, 48), hsl(22 + shift, 80, 58)],
    atmosphere: hsl(335 + shift, 90, 68),
  },
  barren: {
    ramp: [hsl(275 + shift, 25, 34), hsl(30 + shift, 35, 46), hsl(28 + shift, 40, 60), hsl(35 + shift, 45, 74)],
    atmosphere: hsl(275 + shift, 70, 72),
  },
  gas: {
    bands: [
      hsl(20 + shift, 80, 62),
      hsl(345 + shift, 70, 66),
      hsl(285 + shift, 50, 56),
      hsl(38 + shift, 85, 76),
      hsl(10 + shift, 70, 52),
    ],
    atmosphere: hsl(335 + shift, 95, 72),
  },
  ocean: {
    ramp: [hsl(225 + shift, 75, 26), hsl(210 + shift, 80, 42), hsl(195 + shift, 85, 56), hsl(160 + shift, 70, 60)],
    sea: 0.8,
    atmosphere: hsl(205 + shift, 100, 70),
    clouds: 0.9,
  },
});

const MAP_WIDTH = 192;
const MAP_HEIGHT = 96;

export interface PlanetPixels {
  readonly surface: PixelImage;
  /** Absent for a world without an atmosphere layer. */
  readonly clouds: PixelImage | null;
  /** Atmosphere rim colour, 0..255 RGB. */
  readonly atmosphere: Rgb;
  /** A strip across the ring, inner edge to outer edge; absent without rings. */
  readonly ring: PixelImage | null;
}

interface SpherePoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly lat: number;
  readonly lon: number;
}
interface NoiseOffset {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function gasColour(genome: PlanetGenome, bands: readonly Rgb[], point: SpherePoint, offset: NoiseOffset): Rgb {
  const { x, y, z, lat, lon } = point;
  const turbulence = fbm(x * 1.1 + offset.x, y * 1.1 + offset.y, z * 1.1 + offset.z, 2);
  const flow = y * 2.4 + turbulence * 0.45;
  let colour = ramp(bands, 0.5 + 0.5 * Math.sin(flow * 4.2));
  colour = mixRgb(colour, ramp(bands, 0.5 + 0.5 * Math.sin(flow * 2.1 + 1.7)), 0.35);
  // The great storm: a pale oval.
  const delta = Math.atan2(Math.sin(lon - 1.4), Math.cos(lon - 1.4));
  const oval = Math.pow((delta * Math.cos(lat)) / 0.34, 2) + Math.pow((lat + 0.3) / 0.15, 2);
  return oval < 1 ? mixRgb(colour, hsl(15 + genome.hueShift, 90, 82), smooth(1, 0.4, oval)) : colour;
}

function solidColour(genome: PlanetGenome, style: BiomeStyle, point: SpherePoint, offset: NoiseOffset): Rgb {
  const { x, y, z } = point;
  const warp = fbm(x * 0.9 + offset.x, y * 0.9 + offset.y, z * 0.9 + offset.z, 2);
  const height = 0.5 + fbm(x * 1.3 + offset.x + warp, y * 1.3 + offset.y + warp, z * 1.3 + offset.z, 3) * 1.1;
  const colours = style.ramp!;
  let colour: Rgb;
  if (style.sea !== undefined) {
    const seaLevel = style.sea * 0.5 + 0.2;
    colour =
      height < seaLevel
        ? ramp(colours.slice(0, 2), height / seaLevel)
        : ramp(colours.slice(1), ((height - seaLevel) / (1 - seaLevel)) * 0.9 + 0.1);
    if (Math.abs(height - seaLevel) < 0.03) colour = mixRgb(colour, colours[1]!, 0.5);
  } else {
    colour = ramp(colours, height);
  }
  const cap = smooth(0.82, 0.9, Math.abs(y) + warp * 0.1);
  return genome.type !== 'scorched' && cap > 0 ? mixRgb(colour, [244, 248, 255], cap * 0.9) : colour;
}

function ringStrip(genome: PlanetGenome): PixelImage {
  const width = 128;
  const data = new Uint8Array(width * 4);
  const inner = hsl(30 + genome.hueShift, 70, 78);
  const outer = hsl(330 + genome.hueShift, 55, 70);
  for (let i = 0; i < width; i++) {
    const u = i / width;
    const colour = mixRgb(inner, outer, 0.5 + 0.5 * Math.sin(u * 9));
    const alpha =
      (u > 0.55 && u < 0.6 ? 0.15 : 1) * smooth(0, 0.12, u) * smooth(1, 0.85, u) * (0.55 + 0.3 * Math.sin(u * 23));
    data.set([colour[0], colour[1], colour[2], alpha * 255], i * 4);
  }
  return { data, width, height: 1 };
}

/** Paints a planet: surface map, optional cloud layer, atmosphere colour and optional ring strip. */
export function paintPlanet(genome: PlanetGenome): PlanetPixels {
  const style = biomeStyle(genome.hueShift)[genome.type];
  const surface = new Uint8Array(MAP_WIDTH * MAP_HEIGHT * 4);
  const cloudStrength = style.clouds;
  const clouds = cloudStrength === undefined ? null : new Uint8Array(MAP_WIDTH * MAP_HEIGHT * 4);
  const random = seededRandom(genome.id + 'tex');
  const offset = { x: random() * 40, y: random() * 40, z: random() * 40 };
  for (let row = 0; row < MAP_HEIGHT; row++) {
    const lat = -Math.PI / 2 + ((row + 0.5) / MAP_HEIGHT) * Math.PI;
    const y = Math.sin(lat);
    const ring = Math.cos(lat);
    for (let column = 0; column < MAP_WIDTH; column++) {
      const lon = ((column + 0.5) / MAP_WIDTH) * TAU;
      const point = { x: ring * Math.cos(lon), y, z: ring * Math.sin(lon), lat, lon };
      const at = (row * MAP_WIDTH + column) * 4;
      const colour =
        genome.type === 'gas'
          ? gasColour(genome, style.bands!, point, offset)
          : solidColour(genome, style, point, offset);
      surface.set([colour[0], colour[1], colour[2], 255], at);
      if (clouds !== null && cloudStrength !== undefined) {
        const density = fbm(point.x * 1.6 + offset.z, y * 3 + offset.x, point.z * 1.6 + offset.y, 3);
        clouds.set([255, 255, 255, clamp(smooth(0.04, 0.3, density) * 230 * cloudStrength, 0, 255)], at);
      }
    }
  }
  return {
    surface: { data: surface, width: MAP_WIDTH, height: MAP_HEIGHT },
    clouds: clouds === null ? null : { data: clouds, width: MAP_WIDTH, height: MAP_HEIGHT },
    atmosphere: style.atmosphere,
    ring: genome.rings ? ringStrip(genome) : null,
  };
}

function stopsAlpha(stops: readonly (readonly [number, number])[], at: number): number {
  for (let i = 1; i < stops.length; i++) {
    const [endOffset, endAlpha] = stops[i]!;
    const [startOffset, startAlpha] = stops[i - 1]!;
    if (at <= endOffset) {
      const span = endOffset - startOffset;
      return span <= 0 ? endAlpha : startAlpha + ((endAlpha - startAlpha) * (at - startOffset)) / span;
    }
  }
  return stops[stops.length - 1]![1];
}

/** A soft radial falloff, white, with (offset, alpha) stops: the sun glow and bloom sprites. */
export function radialGlow(stops: readonly (readonly [number, number])[], size = 128): PixelImage {
  const data = new Uint8Array(size * size * 4);
  const centre = (size - 1) / 2;
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const distance = Math.hypot(column - centre, row - centre) / (size / 2);
      const alpha = distance >= 1 ? 0 : stopsAlpha(stops, distance);
      data.set([255, 255, 255, Math.round(alpha * 255)], (row * size + column) * 4);
    }
  }
  return { data, width: size, height: size };
}

/** A cartoon cloud puff: a few soft blobs from one fixed seed. */
export function cloudPuff(size = 128): PixelImage {
  const random = seededRandom('puff');
  const blobs = Array.from({ length: 9 }, () => ({
    x: size / 2 + (random() - 0.5) * 52,
    y: size / 2 + (random() - 0.5) * 30,
    radius: 18 + random() * 22,
  }));
  const data = new Uint8Array(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      let alpha = 0;
      for (const blob of blobs) {
        const distance = Math.hypot(column - blob.x, row - blob.y) / blob.radius;
        if (distance >= 1) continue;
        const falloff = distance < 0.7 ? 0.55 - (0.2 * distance) / 0.7 : (0.35 * (1 - distance)) / 0.3;
        alpha = alpha + falloff * (1 - alpha);
      }
      data.set([255, 255, 255, Math.round(alpha * 255)], (row * size + column) * 4);
    }
  }
  return { data, width: size, height: size };
}
