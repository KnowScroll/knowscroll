import { FIELD_OF_VIEW, type CameraPose } from '../space/camera-rig';
import { lerp, logLerp, progress, rise, smootherstep, smoothstep, easeOut, clamp01 } from './easing';
import { add, cross, dot, length, mix, normalize, scale, sub, type Vec3 } from './vec3';

/**
 * Entering a planet (design "Enter a planet", 29 Oct; "with rings or a moon", 30 Oct): one calm glide
 * from the system view down to the planet, while the globe of the planet's own view comes into focus
 * exactly on the 3D planet. 4.0 s, the glide 3.0 s of it. Everything is a pure function of `t`.
 */
export const ENTER_PLANET = {
  seconds: 4.0,
  glideStart: 0.15,
  glideEnd: 3.15,
  tapSeconds: 0.6,
} as const;

/** The globe's own design radius in pixels at 390 x 844; the overlay is scaled by projected radius over this. */
export const DESIGN_GLOBE_RADIUS = 146;

/** Where the planet's own view puts its globe on the screen: centre and radius in layout pixels. */
export interface GlobePlacement {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export interface EnterPlanetScene {
  /** The system view's camera, without its drift. */
  readonly from: CameraPose;
  /** The planet's centre now (it keeps revolving on the way in). */
  readonly planet: Vec3;
  readonly planetRadius: number;
  readonly sun: Vec3;
  /** The canvas size in layout pixels. */
  readonly screen: { readonly width: number; readonly height: number };
  /** Where the globe of the planet's view sits when the glide ends. */
  readonly globe: GlobePlacement;
}

/** The distance at which the close-up easing begins: the design's 30, in this scene's smaller units. */
const CLOSE_UP_FROM = 30 / 2.18;
const TAN_HALF_FOV = Math.tan((FIELD_OF_VIEW / 2) * (Math.PI / 180));

/**
 * How far the camera ends from the planet, and how far below the planet's centre it looks, so that the
 * planet lands where the globe is drawn with the globe's radius. The design's own numbers for a 390 x 844
 * screen are 8.455 radii and 0.0408 of that distance below.
 */
export function finalFraming(
  planetRadius: number,
  screen: EnterPlanetScene['screen'],
  globe: GlobePlacement,
): { distance: number; lookBelow: number } {
  const half = screen.height / 2;
  const tanAngle = (globe.radius * TAN_HALF_FOV) / half;
  const distance = planetRadius / Math.sin(Math.atan(tanAngle));
  const centreHeight = (half - globe.y) / half;
  return { distance, lookBelow: distance * centreHeight * TAN_HALF_FOV };
}

/** The view line at the end of the glide, from the planet to the camera: mostly lit, a little from above. */
export function finalDirection(planet: Vec3, sun: Vec3): Vec3 {
  const towardSun = normalize(sub(sun, planet));
  const side = normalize(cross([0, 1, 0], towardSun));
  return normalize(add(add(scale(towardSun, 0.7), [0, 0.45, 0]), scale(side, 0.55)));
}

/** Progress along the glide, 0 to 1. */
export const glideProgress = (t: number): number => progress(t, ENTER_PLANET.glideStart, ENTER_PLANET.glideEnd);

export function cameraAt(t: number, scene: EnterPlanetScene): CameraPose {
  const x = glideProgress(t);
  const e = smootherstep(Math.pow(x, 0.82));
  const { distance: end, lookBelow } = finalFraming(scene.planetRadius, scene.screen, scene.globe);
  const away = sub(scene.from.position, scene.planet);
  const start = length(away);
  const startDirection = normalize(away);
  const direction = normalize(mix(startDirection, finalDirection(scene.planet, scene.sun), smootherstep(1.6 * x)));
  const distance = logLerp(start, end, e);
  const position = add(scene.planet, scale(direction, distance));
  // At the end the camera looks a little below the planet's centre, which puts the planet where the globe is.
  const forward = scale(normalize(sub(scene.planet, position)), 1);
  const up = normalize(sub([0, 1, 0], scale(forward, dot([0, 1, 0], forward))));
  const finalTarget = sub(scene.planet, scale(up, lookBelow));
  const target = mix(scene.from.target, finalTarget, smootherstep(1.35 * x));
  return { position, target, fov: FIELD_OF_VIEW + 4 * Math.pow(Math.sin(Math.PI * e), 2) };
}

export interface EnterPlanetChrome {
  /** The system's header, chips and names fade (0.03 to 0.3 s). */
  readonly systemOpacity: number;
  /** The tap ring opens where the planet was touched. */
  readonly tapRing: { opacity: number; scale: number };
  readonly back: { opacity: number; offset: number };
  readonly title: { opacity: number; offset: number };
  readonly hint: { opacity: number; offset: number };
  readonly chips: { opacity: number; offset: number };
}

/** How the globe of the planet's own view is drawn over the 3D planet. */
export interface GlobeAppearance {
  /** Opacity of the globe; the 3D planet's painted ring and moon fade on the same curve, mirrored. */
  readonly opacity: number;
  /** Blur in pixels on the globe only, sharper as it nears. */
  readonly blur: number;
  /** The starfield of the planet's own view comes in at the end. */
  readonly stars: number;
  /** The planet's atmosphere strength and the sun's bloom ease down up close, else the planet washes out. */
  readonly atmosphere: number;
  readonly sunBloom: number;
  readonly sunGlow: number;
  /** The parked ship shrinks away in the first 0.6 s, or it would be a spike up close. */
  readonly shipScale: number;
}

/**
 * How much of the planet view's own sky has taken over from the 3D scene: 0 in the glide, 1 at its end. The 3D canvas, with its
 * neighbours, haze and limb, fades out over the last 0.45 s as this rises, so the last frame of the glide is the planet view's
 * black sky with only the globe on it (the design brings the U03 starfield in at the end).
 */
export const skyAt = (t: number): number => smoothstep(0.85, 1, glideProgress(t));

export function globeAt(t: number, distance: number, endDistance: number): GlobeAppearance {
  const x = glideProgress(t);
  const opacity = smoothstep(0.3, 0.97, x);
  const near = clamp01(
    Math.log(CLOSE_UP_FROM / Math.max(distance, endDistance)) / Math.log(CLOSE_UP_FROM / endDistance),
  );
  return {
    opacity,
    blur: 6 * (1 - opacity),
    stars: skyAt(t),
    atmosphere: lerp(1.15, 0.32, near),
    sunBloom: lerp(1, 0.25, near),
    sunGlow: lerp(1, 0.4, near),
    shipScale: 1 - smoothstep(ENTER_PLANET.glideStart, ENTER_PLANET.glideStart + 0.6, t),
  };
}

export function chromeAt(t: number): EnterPlanetChrome {
  const ring = clamp01(t / ENTER_PLANET.tapSeconds);
  return {
    systemOpacity: 1 - smoothstep(0.03, 0.3, t),
    tapRing: { opacity: t < ENTER_PLANET.tapSeconds ? 0.9 * (1 - ring) : 0, scale: 1 + 2.2 * easeOut(ring) },
    back: rise(t, 3.05, 3.55, -8),
    title: rise(t, 3.15, 3.7, 10),
    hint: rise(t, 3.3, 3.85, 10),
    chips: rise(t, 3.45, 4.0, 10),
  };
}

/**
 * Hands the 3D planet's ring over to the planet view's ring (design 3b). `weight` is 0 until the glide's
 * progress .22 and 1 at .88; the 3D ring's band goes from 1.4 / 2.4 radii to 1.42 / 1.56 and it turns to
 * the planet view's tilt. The moon leaves its orbit from the start of the glide for the planet view's
 * place on the near side, and both fade out on the hand-over (2.55 to 3.06 s).
 */
export interface RingHandover {
  readonly weight: number;
  readonly inner: number;
  readonly outer: number;
  readonly moonWeight: number;
  readonly fade: number;
}

export function handoverAt(t: number): RingHandover {
  const x = glideProgress(t);
  const weight = smootherstep(progress(x, 0.22, 0.88));
  return {
    weight,
    inner: lerp(1.4, 1.42, weight),
    outer: lerp(2.4, 1.56, weight),
    moonWeight: smootherstep(progress(t, ENTER_PLANET.glideStart, 1.5)),
    fade: 1 - smoothstep(2.55, 3.06, t),
  };
}

/** The camera-space normal of the planet view's ring, before it is turned 14 degrees about the view axis. */
export const RING_NORMAL: Vec3 = [0, 0.975, 0.223];
export const RING_TURN = (14 * Math.PI) / 180;

/** Clamps `t` to the animation's length. */
export const clampT = (t: number): number => Math.min(Math.max(t, 0), ENTER_PLANET.seconds);
